/** @jest-environment node */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createResearchRepository,
  getResearchDatabaseConfiguration,
} from '../../../services/research/research.repository';
import {
  assertResearchRequest,
  readResearchRequestBody,
  researchErrorResponse,
} from '../../../services/research/research.http';
import {
  getCanonicalResearchJson,
  MAXIMUM_RESEARCH_BODY_BYTES,
} from '../../../services/research/research.validation';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_RESEARCH_MIGRATION } from '../../../services/research/research.migration';

jest.mock('server-only', () => ({}), { virtual: true });

const now = Date.UTC(2026, 8, 9, 12);
const contract = {
  ticker: 'KXBTC15M-TEST',
  eventTicker: 'KXBTC15M-TEST',
  seriesTicker: 'KXBTC15M',
  target: 50000,
  startsAt: now,
  expiresAt: now + 900_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
const evidence = (id = 'one') => ({
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshiMarket: contract,
  schemaVersion: 1,
  eventId: `${id}:decision:pending`,
  forecastId: id,
  event: 'decision',
  recordedAt: now + 180_000,
  inputObservedAt: now + 180_000,
  featureCutoffAt: now + 180_000,
  expiresAt: now + 900_000,
  target: 50000,
  aboveProbability: 0.6,
  belowProbability: 0.4,
  pressure: { signedVolume: 3.2 },
});
const forecast = (overrides = {}) => ({
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshiMarket: contract,
  id: 'one',
  status: 'pending',
  createdAt: now + 180_000,
  startsAt: now,
  expiresAt: now + 900_000,
  modelVersion: 'trade-pressure-log-return-v1',
  target: 50000,
  price: 50010,
  aboveProbability: 0.6,
  belowProbability: 0.4,
  direction: 'above',
  calculationMode: 'pressure-adjusted',
  ...overrides,
});
const artifact = {
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  id: 'candidate-one',
  version: 'outcome-logistic-v1',
  trainedAt: now,
  status: 'shadow',
  model: { coefficients: [0.1, 0.2] },
};

describe('durable research evidence', () => {
  let client;
  let repository;
  beforeEach(() => {
    client = createClient({ url: 'file::memory:' });
    repository = createResearchRepository({ client });
  });
  afterEach(() => client.close());

  test('persists evidence, treats reordered exact duplicates as idempotent, and rejects changed events', async () => {
    const row = evidence();
    expect(await repository.persistEvidenceRows([row])).toEqual({ inserted: 1, duplicates: 0 });
    expect(
      await repository.persistEvidenceRows([{ ...row, pressure: { signedVolume: 3.2 } }]),
    ).toEqual({ inserted: 0, duplicates: 1 });
    await expect(
      repository.persistEvidenceRows([{ ...row, aboveProbability: 0.9 }]),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repository.readStoredEvidence()).rows).toEqual([row]);
  });

  test('removes old research atomically once, retains all Kalshi records, and blocks stale writers', async () => {
    await repository.persistEvidenceRows([evidence()]);
    await repository.persistForecastSnapshots([forecast()]);
    await repository.writeModelArtifact(artifact);
    for (const table of ['evidence_events', 'forecast_snapshots', 'model_artifacts'])
      await client.execute(`DROP TRIGGER ${table}_kalshi_only`);
    await client.execute('DELETE FROM research_migrations');
    const old = { outcomeDefinition: 'coinbase-last-trade-at-deadline-v1' };
    await client.execute({
      sql: 'INSERT INTO evidence_events(event_id,forecast_id,recorded_at,content_hash,payload) VALUES (?,?,?,?,?)',
      args: ['old-event', 'old', now, 'old', JSON.stringify(old)],
    });
    await client.execute({
      sql: 'INSERT INTO forecast_snapshots(snapshot_id,forecast_id,state,state_rank,created_at,content_hash,payload) VALUES (?,?,?,?,?,?,?)',
      args: ['old-snapshot', 'old', 'pending', 1, now, 'old', JSON.stringify(old)],
    });
    await client.execute({
      sql: 'INSERT INTO model_artifacts(model_id,saved_at,content_hash,payload) VALUES (?,?,?,?)',
      args: ['old-model', now, 'old', JSON.stringify(old)],
    });
    await client.execute({
      sql: 'INSERT INTO model_activations(model_id,activated_at,evaluation) VALUES (?,?,?)',
      args: ['old-model', now, '{}'],
    });
    const migrated = createResearchRepository({ client });
    expect(await migrated.getResearchStatus()).toMatchObject({
      evidenceCount: 1,
      forecastCount: 1,
      modelCount: 1,
    });
    expect((await migrated.readStoredEvidence()).rows).toEqual([evidence()]);
    expect((await migrated.readStoredForecasts()).rows).toEqual([forecast()]);
    expect(await migrated.readModelArtifacts()).toEqual([artifact]);
    const migration = await client.execute({
      sql: 'SELECT details FROM research_migrations WHERE migration_id = ?',
      args: [KALSHI_RESEARCH_MIGRATION],
    });
    expect(JSON.parse(migration.rows[0].details).removed).toEqual({
      evidence_events: 1,
      forecast_snapshots: 1,
      model_artifacts: 1,
      model_activations: 1,
    });
    await expect(
      client.execute({
        sql: 'INSERT INTO evidence_events(event_id,forecast_id,recorded_at,content_hash,payload) VALUES (?,?,?,?,?)',
        args: ['late-old', 'old', now, 'old', JSON.stringify(old)],
      }),
    ).rejects.toThrow('Only Kalshi');
    expect(await createResearchRepository({ client }).getResearchStatus()).toMatchObject({
      evidenceCount: 1,
      forecastCount: 1,
      modelCount: 1,
    });
    expect(
      (await client.execute('SELECT COUNT(*) AS count FROM research_migrations')).rows[0].count,
    ).toBe(1);
  });

  test('archives awaiting settlement without blocking later official results or changing a fixed call', async () => {
    const pending = forecast();
    const awaiting = { ...pending, status: 'awaiting-settlement' };
    const resolved = { ...pending, status: 'resolved', outcome: 'above', correct: true };
    await repository.persistForecastSnapshots([pending, awaiting, resolved]);
    expect((await repository.readStoredForecasts()).rows).toEqual([resolved]);
    await expect(
      repository.persistForecastSnapshots([
        { ...awaiting, aboveProbability: 0.7, belowProbability: 0.3 },
      ]),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('rolls back all additions in an evidence batch containing a conflicting duplicate', async () => {
    await repository.persistEvidenceRows([evidence()]);
    await expect(
      repository.persistEvidenceRows([
        evidence('two'),
        { ...evidence(), pressure: { signedVolume: -5 } },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repository.getResearchStatus()).evidenceCount).toBe(1);
  });

  test('paginates evidence without skipping rows sharing a timestamp', async () => {
    await repository.persistEvidenceRows(['one', 'two', 'three'].map(evidence));
    const first = await repository.readStoredEvidence({ limit: 2 });
    const second = await repository.readStoredEvidence({ after: first.nextCursor, limit: 2 });
    expect(first.rows.map((row) => row.forecastId)).toEqual(['one', 'two']);
    expect(second.rows.map((row) => row.forecastId)).toEqual(['three']);
    expect(second.nextCursor).toBeNull();
    expect(await repository.getResearchRows()).toHaveLength(3);
    await expect(repository.getResearchRows({ maximumRows: 2 })).rejects.toMatchObject({
      status: 413,
    });
  });

  test('loads only fixed decisions and outcome events for learning while retaining all observations', async () => {
    const observation = { ...evidence('observation'), event: 'observation' };
    const outcome = { ...evidence('outcome'), event: 'outcome' };
    await repository.persistEvidenceRows([observation, evidence(), outcome]);
    expect(await repository.getLearningEvidenceRows()).toEqual([evidence(), outcome]);
    expect(await repository.getResearchRows()).toEqual([observation, evidence(), outcome]);
  });

  test('retains original snapshots while returning the final forecast even after out-of-order delivery', async () => {
    const pending = forecast();
    const resolved = forecast({
      status: 'resolved',
      observedAt: now + 899_000,
      observedPrice: 50100,
      outcome: 'above',
      correct: true,
    });
    await repository.persistForecastSnapshots([resolved]);
    await repository.persistForecastSnapshots([pending]);
    expect((await repository.readStoredForecasts()).rows).toEqual([resolved]);
    expect((await repository.readForecastSnapshotEvents()).rows).toEqual([resolved, pending]);
    expect(await repository.getResearchStatus()).toMatchObject({
      forecastCount: 1,
      snapshotCount: 2,
    });
  });

  test('allows an analyzing pressure forecast to publish a learned model while freezing its captured fields', async () => {
    const analyzing = forecast({
      createdAt: now,
      status: 'analyzing',
      aboveProbability: null,
      belowProbability: null,
      calculationMode: null,
      direction: 'neutral',
    });
    await repository.persistForecastSnapshots([analyzing]);
    const learned = forecast({
      modelVersion: 'outcome-logistic-v1',
      learning: { modelId: 'candidate-one' },
    });
    await repository.persistForecastSnapshots([learned]);
    await expect(
      repository.persistForecastSnapshots([
        { ...learned, status: 'resolved', aboveProbability: 0.8, belowProbability: 0.2 },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.persistForecastSnapshots([
        { ...learned, status: 'resolved', learning: { modelId: 'candidate-two' } },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repository.readStoredForecasts()).rows).toEqual([learned]);
  });

  test('compares nested immutable values independently of incoming JSON key order', async () => {
    await repository.persistForecastSnapshots([
      forecast({ analysis: { startedAt: now, policyVersion: 'test' } }),
    ]);
    await expect(
      repository.persistForecastSnapshots([
        forecast({ status: 'unobserved', analysis: { policyVersion: 'test', startedAt: now } }),
      ]),
    ).resolves.toMatchObject({ inserted: 1 });
  });

  test.each(['target', 'expiresAt'])(
    'does not change the original %s between statuses',
    async (field) => {
      await repository.persistForecastSnapshots([forecast()]);
      await expect(
        repository.persistForecastSnapshots([
          forecast({ status: 'resolved', [field]: forecast()[field] + 1 }),
        ]),
      ).rejects.toMatchObject({ status: 400 });
    },
  );

  test('does not replace an unobserved final result or rewrite a withheld decision', async () => {
    await repository.persistForecastSnapshots([forecast({ status: 'unobserved' })]);
    await expect(
      repository.persistForecastSnapshots([forecast({ status: 'resolved' })]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.persistForecastSnapshots([
        forecast({
          status: 'withheld',
          aboveProbability: null,
          belowProbability: null,
          direction: 'neutral',
        }),
      ]),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('serializes concurrent duplicate deliveries without losing evidence', async () => {
    const result = await Promise.all([
      repository.persistEvidenceRows([evidence()]),
      repository.persistEvidenceRows([evidence()]),
    ]);
    expect(result.reduce((count, value) => count + value.inserted, 0)).toBe(1);
    expect(result.reduce((count, value) => count + value.duplicates, 0)).toBe(1);
  });

  test('rejects retired Coinbase research and targets that are not a real Kalshi contract', async () => {
    const missed = {
      ...evidence(),
      event: 'missed-start',
      decision: 'missed-start',
      cohort: 'scheduled-background',
      modelVersion: 'unavailable',
      policyVersion: 'scheduled-background-v1',
      windowStartAt: now,
      target: null,
      aboveProbability: null,
      belowProbability: null,
      inputObservedAt: null,
      featureCutoffAt: null,
    };
    await expect(repository.persistEvidenceRows([missed])).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.persistEvidenceRows([{ ...missed, eventId: 'bad-missed', spot: 50000 }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('permits one learning worker until its lease expires and only its owner can release it', async () => {
    expect(
      await repository.acquireLearningLease({ ownerId: 'first', now, expiresAt: now + 60_000 }),
    ).toBe(true);
    expect(
      await repository.acquireLearningLease({ ownerId: 'second', now, expiresAt: now + 60_000 }),
    ).toBe(false);
    await repository.releaseLearningLease('second');
    expect(
      await repository.acquireLearningLease({ ownerId: 'second', now, expiresAt: now + 60_000 }),
    ).toBe(false);
    expect(
      await repository.acquireLearningLease({
        ownerId: 'second',
        now: now + 60_000,
        expiresAt: now + 120_000,
      }),
    ).toBe(true);
    await repository.releaseLearningLease('first');
    expect(
      await repository.acquireLearningLease({
        ownerId: 'third',
        now: now + 60_000,
        expiresAt: now + 120_000,
      }),
    ).toBe(false);
    await repository.releaseLearningLease('second');
    expect(
      await repository.acquireLearningLease({
        ownerId: 'third',
        now: now + 60_000,
        expiresAt: now + 120_000,
      }),
    ).toBe(true);
  });

  test.each([
    { eventId: '' },
    { eventId: 'bad\nidentity' },
    { recordedAt: NaN },
    { target: -1 },
    { aboveProbability: 1.01 },
    { inputObservedAt: now + 181_000 },
    { features: { invalid: Infinity } },
  ])('rejects invalid evidence without writing it: %j', async (patch) => {
    await expect(
      repository.persistEvidenceRows([{ ...evidence(), ...patch }]),
    ).rejects.toMatchObject({ status: 400 });
    expect((await repository.getResearchStatus()).evidenceCount).toBe(0);
  });

  test('bounds request batches, individual payloads, and page sizes', async () => {
    await expect(
      repository.persistEvidenceRows(
        Array.from({ length: 101 }, (_, index) => evidence(String(index))),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.persistEvidenceRows([{ ...evidence(), oversized: 'x'.repeat(128 * 1024) }]),
    ).rejects.toMatchObject({ status: 413 });
    await expect(repository.readStoredEvidence({ limit: 2001 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(repository.readStoredForecasts({ after: '-1' })).rejects.toMatchObject({
      status: 400,
    });
  });

  test('saves immutable models and preserves separate prospective promotion evidence', async () => {
    await repository.saveModelArtifact(artifact);
    await repository.saveModelArtifact(artifact);
    expect(await repository.getActiveModel()).toBeNull();
    await expect(
      repository.saveModelArtifact({ ...artifact, model: { coefficients: [8] } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(repository.activateModelArtifact(artifact.id)).rejects.toMatchObject({
      status: 400,
    });
    const activation = {
      activatedAt: now + 86_400_000,
      shadowEvaluation: {
        eligibleForPromotion: true,
        modelId: artifact.id,
        evaluatedAt: now + 86_400_000,
        independentWindows: 120,
      },
    };
    await repository.activateModelArtifact(artifact.id, activation);
    expect(await repository.getActiveModel()).toEqual({
      ...artifact,
      activation: { modelId: artifact.id, ...activation },
    });
    expect(await repository.readModelArtifacts()).toEqual([artifact]);
    expect(await repository.readModelArtifact(artifact.id)).toEqual(artifact);
  });

  test('retains file-backed research payloads across database process restarts', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-research-test-'));
    const url = pathToFileURL(path.join(folder, 'archive.db')).href;
    const options = {
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        RESEARCH_TEST_URL: url,
        RESEARCH_TEST_PAYLOAD: JSON.stringify(evidence()),
      },
    };
    try {
      execFileSync(
        process.execPath,
        [
          '-e',
          "const {createClient}=require('@libsql/client'); const c=createClient({url:process.env.RESEARCH_TEST_URL}); (async()=>{await c.execute('CREATE TABLE events(payload TEXT)'); await c.execute({sql:'INSERT INTO events VALUES (?)',args:[process.env.RESEARCH_TEST_PAYLOAD]}); c.close();})().catch(()=>process.exit(1));",
        ],
        options,
      );
      const restored = execFileSync(
        process.execPath,
        [
          '-e',
          "const {createClient}=require('@libsql/client'); const c=createClient({url:process.env.RESEARCH_TEST_URL}); c.execute('SELECT payload FROM events').then(r=>{process.stdout.write(r.rows[0].payload);c.close();}).catch(()=>process.exit(1));",
        ],
        options,
      );
      expect(JSON.parse(restored)).toEqual(evidence());
    } finally {
      const resolvedFolder = path.resolve(folder);
      if (
        !resolvedFolder.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
        !path.basename(resolvedFolder).startsWith('bitcoin-research-test-')
      ) {
        throw new Error('Refusing cleanup outside the verified research test directory.');
      }
      await rm(resolvedFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  test('reads a current archive through an external write lock and resumes recording after release', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-research-test-lock-'));
    const url = pathToFileURL(path.join(folder, 'archive.db')).href;
    try {
      // A subprocess releases every Windows native database handle before fixture cleanup.
      const output = execFileSync(
        process.execPath,
        [
          '--conditions=react-server',
          '-e',
          `
          const assert = require('node:assert/strict');
          const { createClient } = require('@libsql/client');
          (async () => {
            await import('tsx');
            const module = await import('./src/services/research/research.repository.js');
            const { createResearchRepository } = module.default ?? module;
            const connection = createClient({ url: process.env.RESEARCH_TEST_URL });
            const viewer = createClient({ url: process.env.RESEARCH_TEST_URL });
            const rows = JSON.parse(process.env.RESEARCH_TEST_PAYLOAD);
            let transaction;
            let stage = 'initial write';
            try {
              const original = createResearchRepository({ client: connection });
              await original.persistEvidenceRows([rows[0]]);
              transaction = await viewer.transaction('write');
              stage = 'locked status';
              const restored = createResearchRepository({ client: connection });
              const locked = await restored.getResearchStatus();
              assert.equal(locked.available, true);
              assert.equal(locked.writeAvailable, false);
              assert.equal(locked.writeStatus, 'locked');
              assert.match(locked.writeReason, /database viewer/);
              assert.deepEqual((await restored.readStoredEvidence()).rows, [rows[0]]);
              await assert.rejects(restored.persistEvidenceRows([rows[1]]), { code: 'SQLITE_BUSY' });
              await transaction.rollback();
              stage = 'unlocked status';
              assert.equal((await restored.getResearchStatus()).writeAvailable, true);
              stage = 'write after lock release';
              assert.deepEqual(await restored.persistEvidenceRows([rows[1]]), { inserted: 1, duplicates: 0 });
              assert.deepEqual((await restored.readStoredEvidence()).rows, rows);
              await connection.execute('DROP INDEX evidence_forecast');
              transaction = await viewer.transaction('write');
              const incomplete = createResearchRepository({ client: connection });
              await assert.rejects(incomplete.getResearchStatus(), { code: 'SQLITE_BUSY' });
              await transaction.rollback();
              stage = 'schema repair after lock release';
              assert.equal((await incomplete.getResearchStatus()).evidenceCount, 2);
              process.stdout.write('verified');
            } catch (error) {
              error.message = stage + ': ' + error.message;
              throw error;
            } finally {
              transaction?.close();
              viewer.close();
              connection.close();
            }
          })().catch(error => { console.error(error); process.exitCode = 1; });
          `,
        ],
        {
          windowsHide: true,
          encoding: 'utf8',
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: path.resolve('jsconfig.json'),
            RESEARCH_TEST_URL: url,
            RESEARCH_TEST_PAYLOAD: JSON.stringify([evidence(), evidence('two')]),
          },
        },
      );
      expect(output).toBe('verified');
    } finally {
      const resolvedFolder = path.resolve(folder);
      if (
        !resolvedFolder.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
        !path.basename(resolvedFolder).startsWith('bitcoin-research-test-lock-')
      )
        throw new Error('Refusing cleanup outside the verified research test directory.');
      await rm(resolvedFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

describe('private research API boundary', () => {
  const request = (url = 'http://localhost:3000/api/research/status', options = {}) =>
    new Request(url, options);
  const credentials = {
    RESEARCH_API_USERNAME: 'research',
    RESEARCH_API_PASSWORD: 'private-test-password',
  };
  const authorization = `Basic ${Buffer.from('research:private-test-password').toString('base64')}`;

  test('explains a database lock without exposing the raw database error or credentials', async () => {
    const error = Object.assign(new Error('private-database-path secret-token'), {
      code: 'SQLITE_BUSY',
    });
    const response = researchErrorResponse(error);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain('database viewer');
    expect(body.error).toContain('Existing data is retained');
    expect(body.error).not.toContain('secret-token');
    expect(body.error).not.toContain('private-database-path');
  });

  test('allows local reads and same-origin local writes without exposing a password', () => {
    expect(() => assertResearchRequest(request(), { environment: {} })).not.toThrow();
    expect(() =>
      assertResearchRequest(request(undefined, { headers: { origin: 'http://localhost:3000' } }), {
        write: true,
        environment: {},
      }),
    ).not.toThrow();
  });
  test('accepts Next loopback alias normalization and requires writes to match the actual Host', () => {
    const normalized = (origin) =>
      request('http://localhost:3001/api/research/status', {
        headers: { host: '127.0.0.1:3001', ...(origin ? { origin } : {}) },
      });
    expect(() => assertResearchRequest(normalized(), { environment: {} })).not.toThrow();
    expect(() =>
      assertResearchRequest(normalized('http://127.0.0.1:3001'), { write: true, environment: {} }),
    ).not.toThrow();
    expect(() =>
      assertResearchRequest(normalized('http://localhost:3001'), { write: true, environment: {} }),
    ).toThrow('same-origin');
    expect(() =>
      assertResearchRequest(normalized('https://127.0.0.1:3001'), { write: true, environment: {} }),
    ).toThrow('same-origin');
    expect(() => assertResearchRequest(normalized(), { environment: { VERCEL: '1' } })).toThrow(
      'RESEARCH_API_USERNAME',
    );
  });
  test.each([
    '127.0.0.1:3002',
    'localhost.evil.example:3001',
    'evil.example:3001',
    'user@localhost:3001',
    'localhost:3001/path',
    'localhost:99999',
    '2130706433:3001',
    '127.1:3001',
  ])('rejects mismatched or malformed normalized Host %s', (host) => {
    expect(() =>
      assertResearchRequest(
        request('http://localhost:3001/api/research/status', { headers: { host } }),
        { environment: {} },
      ),
    ).toThrow('application origin');
  });
  test.each(['http://evil.example', 'null', undefined])(
    'rejects local writes with origin %s',
    (origin) => {
      expect(() =>
        assertResearchRequest(request(undefined, { headers: origin ? { origin } : {} }), {
          write: true,
          environment: {},
        }),
      ).toThrow('same-origin');
    },
  );
  test('rejects mismatched host headers, cross-site writes, and similar-looking localhost hosts', () => {
    expect(() =>
      assertResearchRequest(request(undefined, { headers: { host: 'evil.example' } }), {
        environment: {},
      }),
    ).toThrow('application origin');
    expect(() =>
      assertResearchRequest(
        request(undefined, {
          headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' },
        }),
        { write: true, environment: {} },
      ),
    ).toThrow('same-origin');
    expect(() =>
      assertResearchRequest(request('https://localhost.evil.example/api/research/status'), {
        environment: {},
      }),
    ).toThrow('RESEARCH_API_USERNAME');
  });
  test('keeps hosted reads and writes closed until credentials are configured', () => {
    expect(() =>
      assertResearchRequest(request('https://tracker.example/api/research/status'), {
        environment: {},
      }),
    ).toThrow('RESEARCH_API_USERNAME');
    expect(() =>
      assertResearchRequest(request('https://tracker.example/api/research/status'), {
        environment: credentials,
      }),
    ).toThrow('Sign in');
    expect(() =>
      assertResearchRequest(
        request('https://tracker.example/api/research/status', { headers: { authorization } }),
        { environment: credentials },
      ),
    ).not.toThrow();
    expect(() => assertResearchRequest(request(), { environment: { VERCEL: '1' } })).toThrow(
      'RESEARCH_API_USERNAME',
    );
  });
  test('requires credentials on localhost too when configured and refuses plaintext remote authentication', () => {
    expect(() => assertResearchRequest(request(), { environment: credentials })).toThrow('Sign in');
    expect(() =>
      assertResearchRequest(
        request('http://tracker.example/api/research/status', { headers: { authorization } }),
        { environment: credentials },
      ),
    ).toThrow('HTTPS');
  });
  test('challenges unauthorized users without caching responses or leaking underlying storage errors', async () => {
    let error;
    try {
      assertResearchRequest(request(), { environment: credentials });
    } catch (caught) {
      error = caught;
    }
    const response = researchErrorResponse(error);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic realm');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const unavailable = researchErrorResponse(new Error('secret-token=not-for-browser'));
    expect(await unavailable.text()).not.toContain('secret-token');
  });
  test('parses a bounded JSON stream and rejects wrong content types or malformed JSON', async () => {
    const jsonRequest = (body, headers = {}) =>
      request(undefined, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    await expect(readResearchRequestBody(jsonRequest('{"evidence":[]}'))).resolves.toEqual({
      evidence: [],
    });
    await expect(readResearchRequestBody(jsonRequest('{broken'))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      readResearchRequestBody(jsonRequest('{}', { 'content-type': 'text/plain' })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readResearchRequestBody(jsonRequest('x'.repeat(MAXIMUM_RESEARCH_BODY_BYTES + 1))),
    ).rejects.toMatchObject({ status: 413 });
  });
  test('does not silently select an ephemeral hosted database', () => {
    expect(getResearchDatabaseConfiguration({})).toMatchObject({ mode: 'local-database' });
    expect(() => getResearchDatabaseConfiguration({ VERCEL: '1' })).toThrow('TURSO_DATABASE_URL');
    expect(() =>
      getResearchDatabaseConfiguration({
        AWS_LAMBDA_FUNCTION_NAME: 'tracker',
        TURSO_DATABASE_URL: 'file:/tmp/research.db',
      }),
    ).toThrow('TURSO_DATABASE_URL');
    expect(() =>
      getResearchDatabaseConfiguration({ TURSO_DATABASE_URL: 'libsql://private.example' }),
    ).toThrow('TURSO_AUTH_TOKEN');
    expect(
      getResearchDatabaseConfiguration({
        TURSO_DATABASE_URL: 'libsql://private.example',
        TURSO_AUTH_TOKEN: 'server-secret',
      }),
    ).toMatchObject({ mode: 'remote-database' });
  });
  test('canonical evidence serialization preserves property names safely and rejects non-JSON values', () => {
    expect(getCanonicalResearchJson(JSON.parse('{"__proto__":{"value":1},"z":2}'))).toBe(
      '{"__proto__":{"value":1},"z":2}',
    );
    expect(() => getCanonicalResearchJson({ missing: undefined })).toThrow('finite JSON');
    expect(() => getCanonicalResearchJson({ callback() {} })).toThrow('finite JSON');
  });
});

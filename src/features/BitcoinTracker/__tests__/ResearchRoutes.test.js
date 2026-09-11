/** @jest-environment node */
import { POST as ingest } from '../../../app/api/research/ingest/route';
import { GET as status } from '../../../app/api/research/status/route';
import { GET as evidence } from '../../../app/api/research/evidence/route';
import { GET as forecasts } from '../../../app/api/research/forecasts/route';
import { GET as exportData } from '../../../app/api/research/export/route';
import { GET as models } from '../../../app/api/research/models/route';
import { GET as analysis } from '../../../app/api/research/analysis/route';
import { POST as analyze } from '../../../app/api/research/analyze/route';
import * as repository from '../../../services/research/research.repository';
import * as learning from '../../../services/research/learning.service';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('../../../services/research/research.repository', () => ({
  persistEvidenceRows: jest.fn(),
  persistForecastSnapshots: jest.fn(),
  getResearchStatus: jest.fn(),
  readStoredEvidence: jest.fn(),
  readStoredForecasts: jest.fn(),
  readForecastSnapshotEvents: jest.fn(),
}));
jest.mock('../../../services/research/learning.service', () => ({
  getResearchModels: jest.fn(),
  getLearningStatus: jest.fn(),
  runLearningCycle: jest.fn(),
}));

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
const event = {
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshiMarket: contract,
  eventId: 'one:decision:pending',
  forecastId: 'one',
  event: 'decision',
  recordedAt: now,
  expiresAt: now + 900_000,
  target: 50000,
  aboveProbability: 0.6,
  belowProbability: 0.4,
};
const snapshot = {
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshiMarket: contract,
  id: 'one',
  createdAt: now,
  expiresAt: now + 900_000,
  target: 50000,
  aboveProbability: 0.6,
  belowProbability: 0.4,
  direction: 'above',
  modelVersion: 'test-model',
  status: 'pending',
};
const request = (endpoint, { body, origin = 'http://localhost:3000', ...options } = {}) =>
  new Request(`http://localhost:3000/api/research/${endpoint}`, {
    ...options,
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('research App Router endpoints', () => {
  let originalEnvironment;
  beforeEach(() => {
    originalEnvironment = process.env;
    process.env = { ...originalEnvironment };
    delete process.env.RESEARCH_API_USERNAME;
    delete process.env.RESEARCH_API_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.NETLIFY;
    repository.persistEvidenceRows.mockResolvedValue({ inserted: 1, duplicates: 0 });
    repository.persistForecastSnapshots.mockResolvedValue({ inserted: 1, duplicates: 0 });
    repository.getResearchStatus.mockResolvedValue({ available: true, evidenceCount: 1 });
    repository.readStoredEvidence.mockResolvedValue({ rows: [event], nextCursor: '2' });
    repository.readStoredForecasts.mockResolvedValue({ rows: [snapshot], nextCursor: null });
    repository.readForecastSnapshotEvents.mockResolvedValue({ rows: [snapshot], nextCursor: null });
    learning.getLearningStatus.mockResolvedValue({ active: null, candidate: null });
    learning.getResearchModels.mockResolvedValue({ active: null, candidate: null });
    learning.runLearningCycle.mockResolvedValue({ lastRun: { status: 'insufficient-data' } });
  });
  afterEach(() => {
    process.env = originalEnvironment;
  });

  test('ingests only validated evidence and snapshots and returns idempotent acknowledgments', async () => {
    const response = await ingest(
      request('ingest', { body: { evidence: [event], forecasts: [snapshot] } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      evidence: { inserted: 1, duplicates: 0 },
      forecasts: { inserted: 1, duplicates: 0 },
    });
    expect(repository.persistEvidenceRows).toHaveBeenCalledWith([event]);
    expect(repository.persistForecastSnapshots).toHaveBeenCalledWith([snapshot]);
  });

  test.each([
    { evidence: null },
    { evidence: [event], forecasts: [{ ...snapshot, target: -1 }] },
    { unexpected: [] },
  ])('rejects invalid batch %j before any storage mutation', async (body) => {
    expect((await ingest(request('ingest', { body }))).status).toBe(400);
    expect(repository.persistEvidenceRows).not.toHaveBeenCalled();
    expect(repository.persistForecastSnapshots).not.toHaveBeenCalled();
  });

  test('rejects cross-origin uploads before any storage mutation', async () => {
    expect(
      (
        await ingest(
          request('ingest', { body: { evidence: [event] }, origin: 'https://evil.example' }),
        )
      ).status,
    ).toBe(403);
    expect(repository.persistEvidenceRows).not.toHaveBeenCalled();
  });

  test('protects every research read when credentials are configured', async () => {
    process.env.RESEARCH_API_USERNAME = 'private';
    process.env.RESEARCH_API_PASSWORD = 'only-for-tests';
    for (const [name, handler] of [
      ['status', status],
      ['evidence', evidence],
      ['forecasts', forecasts],
      ['export', exportData],
      ['models', models],
      ['analysis', analysis],
    ]) {
      const response = await handler(request(name));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Basic');
    }
    expect(repository.getResearchStatus).not.toHaveBeenCalled();
    expect(learning.getLearningStatus).not.toHaveBeenCalled();
    expect(learning.getResearchModels).not.toHaveBeenCalled();
  });

  test('returns no-store status and forwards evidence and forecast pagination', async () => {
    const response = await status(request('status'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ available: true, evidenceCount: 1 });
    expect(await (await evidence(request('evidence?after=2&limit=10'))).json()).toEqual({
      rows: [event],
      nextCursor: '2',
    });
    expect(repository.readStoredEvidence).toHaveBeenCalledWith({ after: '2', limit: '10' });
    expect(await (await forecasts(request('forecasts'))).json()).toEqual({
      rows: [snapshot],
      nextCursor: null,
    });
  });
  test('serves Next-normalized localhost URLs with the browser 127.0.0.1 Host and Origin', async () => {
    const normalizedStatus = new Request('http://localhost:3001/api/research/status', {
      headers: { host: '127.0.0.1:3001' },
    });
    expect((await status(normalizedStatus)).status).toBe(200);
    const normalizedIngest = new Request('http://localhost:3001/api/research/ingest', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3001',
        origin: 'http://127.0.0.1:3001',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ evidence: [event], forecasts: [snapshot] }),
    });
    expect((await ingest(normalizedIngest)).status).toBe(200);
    expect(repository.persistEvidenceRows).toHaveBeenCalledWith([event]);
  });

  test('exports immutable snapshot events rather than overwriting history with current snapshots', async () => {
    const response = await exportData(request('export?type=forecasts&after=3&limit=20'));
    expect(await response.json()).toEqual({
      type: 'forecasts',
      rows: [snapshot],
      nextCursor: null,
    });
    expect(repository.readForecastSnapshotEvents).toHaveBeenCalledWith({ after: '3', limit: '20' });
    expect(repository.readStoredForecasts).not.toHaveBeenCalled();
    expect((await exportData(request('export?type=unknown'))).status).toBe(400);
  });

  test('reading models does not trigger training or promotion', async () => {
    expect(await (await models(request('models'))).json()).toEqual({
      active: null,
      candidate: null,
    });
    expect(learning.runLearningCycle).not.toHaveBeenCalled();
    expect(learning.getLearningStatus).not.toHaveBeenCalled();
    expect(learning.getResearchModels).toHaveBeenCalledTimes(1);
  });

  test('analysis uses only saved evidence and rejects client-supplied models or training rows', async () => {
    expect(await (await analyze(request('analyze', { body: {} }))).json()).toEqual({
      lastRun: { status: 'insufficient-data' },
    });
    expect(learning.runLearningCycle).toHaveBeenCalledTimes(1);
    expect((await analyze(request('analyze', { body: { model: 'force-promote' } }))).status).toBe(
      400,
    );
    expect(learning.runLearningCycle).toHaveBeenCalledTimes(1);
  });

  test('sanitizes storage failure details', async () => {
    repository.getResearchStatus.mockRejectedValue(new Error('database-password=private'));
    const response = await status(request('status'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('database-password');
  });
});

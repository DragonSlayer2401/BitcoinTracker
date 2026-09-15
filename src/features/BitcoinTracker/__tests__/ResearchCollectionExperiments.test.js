/** @jest-environment node */
import { createClient } from '@libsql/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResearchRepository } from '../../../services/research/research.repository';
import { runResearchCollector } from '../../../../scripts/collect-research.runtime';
import {
  collectForwardResearchLabels,
  getCollectorAnalysis,
} from '../../../../scripts/collect-research.analysis';
import { createCollectorStateStore } from '../../../../scripts/collect-research.storage';
import { replayResearchInputSnapshot } from '../utils/researchExperiments.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { getForwardResearchLabels } from '../utils/researchForwardLabels.utils';

jest.mock('server-only', () => ({}));
const start = Date.UTC(2026, 8, 14, 12);
const capturedAt = start + 180_000;
const expiresAt = start + 900_000;
const market = {
  ticker: 'KXBTC15M-TEST',
  eventTicker: 'KXBTC15M-TEST',
  seriesTicker: 'KXBTC15M',
  startsAt: start,
  expiresAt,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  status: 'active',
  receivedAt: capturedAt,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
function benchmarkAt(time = capturedAt) {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: time - (1200 - index) * 1000,
    price: 50_000 * Math.exp(Math.sin(index / 30) * 0.0001),
  }));
  return { available: true, status: 'live', receivedAt: time, current: samples.at(-1), samples };
}

let directory, statePath, client, repository;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bitcoin-experiment-test-'));
  statePath = path.join(directory, 'state.json');
  client = createClient({ url: 'file::memory:' });
  repository = createResearchRepository({ client });
});
afterEach(async () => {
  client.close();
  await rm(directory, { recursive: true, force: true });
});

async function capture() {
  const ticker = {
    price: 50_000,
    bid: 49_999,
    ask: 50_001,
    time: capturedAt,
    receivedAt: capturedAt,
  };
  const benchmark = benchmarkAt();
  const benchmarkStream = {
    start: jest.fn(),
    stop: jest.fn(),
    seed: jest.fn(),
    getSnapshot: () => ({ available: false }),
  };
  const result = await runResearchCollector({
    once: true,
    statePath,
    repository,
    learningService: { getLearningStatus: async () => ({}) },
    createStream: () => ({
      start() {},
      stop() {},
      getSnapshot: () => ({ status: 'live', ticker, quality: { confirmedThrough: capturedAt } }),
    }),
    createFuturesStream: () => ({ start() {}, stop() {}, getSnapshot: () => null }),
    createBenchmarkStream: () => benchmarkStream,
    loadTicker: async () => ticker,
    loadCandles: async () => [],
    loadMarkets: async () => ({ markets: [market] }),
    loadBenchmark: async () => benchmark,
    now: () => capturedAt,
    log: jest.fn(),
  });
  return { result, benchmarkStream, benchmark };
}

test('the collector records paired inputs, replays after canonical DB storage, and scores official settlement', async () => {
  const { result, benchmarkStream } = await capture();
  expect(benchmarkStream.seed).toHaveBeenCalledTimes(1);
  expect(benchmarkStream.stop).toHaveBeenCalledTimes(1);
  const [decision] = await repository.getLearningEvidenceRows();
  expect(decision).toMatchObject({
    checkpointMinutes: 12,
    decision: 'pending',
    researchReplay: { status: 'stored' },
  });
  expect(decision.researchInputSnapshot).toBeUndefined();
  expect(Object.keys(decision.researchExperiment.variants)).toHaveLength(4);
  const stored = await repository.readResearchInputSnapshot(decision.eventId);
  expect(stored.snapshot.input.benchmark.samples).toHaveLength(1201);
  expect(replayResearchInputSnapshot(stored.snapshot).aboveProbability).toBe(
    decision.aboveProbability,
  );
  expect(result.analysis.replay).toMatchObject({ checked: 1, matched: 1, failed: 0 });
  expect(
    JSON.parse(await readFile(`${statePath}.comparison.json`, 'utf8')).comparison.counts
      .recordedExperiments,
  ).toBe(1);
  expect((await repository.getResearchStatus()).forecastCount).toBe(0);

  const store = await createCollectorStateStore({
    statePath,
    persistRows: (rows) => repository.persistEvidenceRows(rows),
  });
  await store.advance({
    now: expiresAt + 1000,
    markets: [
      {
        ...market,
        status: 'finalized',
        result: 'yes',
        settlementPrice: 50_010,
        settledAt: expiresAt + 1000,
        receivedAt: expiresAt + 1000,
      },
    ],
    getEstimate: () => {
      throw new Error('An expired checkpoint must never be backfilled.');
    },
  });
  const report = await getCollectorAnalysis({ repository, now: expiresAt + 1000 });
  const checkpoint = report.comparison.checkpoints.find((group) => group.checkpointMinutes === 12);
  expect(checkpoint.variants.combined.scoredEstimates).toBe(1);
  expect(checkpoint.variants['futures-only'].fallbackEstimates).toBe(1);
  expect(
    report.comparison.checkpoints.find((group) => group.checkpointMinutes === 9).variants.combined
      .callCoverage,
  ).toBe(0);
  expect(report.replay.matched).toBe(1);
});

test('snapshots and evidence commit atomically and reject rewritten inputs on retry', async () => {
  await capture();
  const [decision] = await repository.getLearningEvidenceRows();
  const { snapshot } = await repository.readResearchInputSnapshot(decision.eventId);
  const original = { ...decision, researchInputSnapshot: snapshot };
  expect(await repository.persistEvidenceRows([original])).toEqual({ inserted: 0, duplicates: 1 });
  const modified = JSON.parse(JSON.stringify(original));
  modified.researchInputSnapshot.input.benchmark.samples[0].price += 1;
  await expect(repository.persistEvidenceRows([modified])).rejects.toMatchObject({ status: 409 });
  const fresh = { ...original, eventId: 'new-decision', forecastId: 'new-forecast' };
  await expect(repository.persistEvidenceRows([fresh, modified])).rejects.toMatchObject({
    status: 409,
  });
  expect(await repository.readResearchInputSnapshot('new-decision')).toBeNull();
  expect(await repository.getLearningEvidenceRows()).toHaveLength(1);
});

test('forward labels use exact future BRTI seconds and retain the first observation after failed storage', async () => {
  await capture();
  const time = capturedAt + 15_000;
  const benchmark = benchmarkAt(time);
  const persist = repository.persistForwardLabels;
  let failed = false;
  repository.persistForwardLabels = async (rows) => {
    if (!failed) {
      failed = true;
      throw new Error('offline');
    }
    return persist(rows);
  };
  await expect(
    collectForwardResearchLabels({ repository, benchmark, now: time, statePath }),
  ).rejects.toThrow('offline');
  expect(
    JSON.parse(await readFile(`${statePath}.forward-labels.json`, 'utf8')).pending,
  ).toHaveLength(1);
  await collectForwardResearchLabels({
    repository,
    benchmark: benchmarkAt(time + 1000),
    now: time + 1000,
    statePath,
  });
  const labels = await repository.getForwardResearchLabels();
  expect(labels).toHaveLength(1);
  expect(labels[0]).toMatchObject({
    status: 'observed',
    horizonSeconds: 15,
    dueAt: time,
    recordedAt: time,
    reading: { time, receivedAt: time },
  });
  expect(labels[0].logReturn).toBeCloseTo(
    Math.log(labels[0].reading.price / labels[0].reference.price),
    14,
  );
  const [decision] = await repository.getLearningEvidenceRows();
  const stored = await repository.readResearchInputSnapshot(decision.eventId);
  expect(stored.snapshot.input.benchmark.current.time).toBe(capturedAt);
  expect(replayResearchInputSnapshot(stored.snapshot).aboveProbability).toBe(
    decision.aboveProbability,
  );
});

test('missing exact labels remain missing and proxy captures cannot be labeled as BRTI returns', async () => {
  await capture();
  const captures = await repository.getPendingForwardCaptures({ now: capturedAt + 15_000 });
  const dueAt = capturedAt + 15_000;
  const unavailable = { receivedAt: dueAt + 1000, samples: [{ time: dueAt + 1000, price: 1 }] };
  expect(getForwardResearchLabels(captures, unavailable, dueAt + 1000)).toEqual([]);
  const missed = getForwardResearchLabels(captures, unavailable, dueAt + 600_000);
  expect(missed.find((label) => label.horizonSeconds === 15)).toMatchObject({
    status: 'missing',
    reading: null,
  });
  const proxy = JSON.parse(JSON.stringify(captures));
  proxy[0].decision.referenceSource = 'coinbase-proxy';
  expect(getForwardResearchLabels(proxy, benchmarkAt(dueAt), dueAt)[0]).toMatchObject({
    status: 'missing',
    reason: 'capture-reference-is-not-observed-brti',
  });
});

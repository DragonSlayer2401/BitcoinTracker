/** @jest-environment node */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireCollectorLock,
  createCollectorStateStore as createContractStateStore,
  writeCollectorState,
} from '../../../../scripts/collect-research.storage';
import {
  parseCollectorOptions,
  runResearchCollector as runContractCollector,
} from '../../../../scripts/collect-research.runtime';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const createCollectorStateStore = createContractStateStore;
const runResearchCollector = runContractCollector;

jest.mock('server-only', () => ({}));
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  rename: jest.fn(jest.requireActual('node:fs/promises').rename),
}));
jest.mock('@libsql/client', () => ({ createClient: jest.fn() }));
jest.mock('../utils/researchForecast.utils', () => ({
  getResearchForecast: jest.fn(() => ({
    available: true,
    aboveProbability: 0.51,
    belowProbability: 0.49,
    modelVersion: 'test-model',
  })),
}));

const start = 1_800_000_000_000;
const quote = (time, price = 100_000) => ({ time, receivedAt: time, price });
const getEstimate = () => ({
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  available: true,
  aboveProbability: 0.51,
  belowProbability: 0.49,
  modelVersion: 'test-model',
});
const marketAt = (time, target = 100_000) => ({
  ticker: 'KXBTC15M-TEST',
  eventTicker: 'KXBTC15M-TEST',
  seriesTicker: 'KXBTC15M',
  target,
  startsAt: start,
  expiresAt: start + 900_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
  receivedAt: time,
});
const input = (time = start + 180_000, price = 100_000) => ({
  markets: [marketAt(time)],
  now: time,
  ticker: quote(time, price),
  getEstimate,
});
let directory;
let statePath;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bitcoin-collector-test-'));
  statePath = path.join(directory, 'collector-state.json');
  getResearchForecast.mockReturnValue(getEstimate());
});
afterEach(async () => {
  // This directory is created solely for this test; never resolve cleanup from user input.
  if (
    directory &&
    path.dirname(directory) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith('bitcoin-collector-test-')
  ) {
    await rm(directory, { recursive: true });
  }
});

test('an atomic state replacement leaves valid JSON and no temporary files', async () => {
  await writeCollectorState(statePath, { original: true });
  await writeCollectorState(statePath, { replacement: true });
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ replacement: true });
  expect(await readdir(directory)).toEqual(['collector-state.json']);
});

test('retries a temporary Windows file lock while keeping the original state until replacement', async () => {
  await writeCollectorState(statePath, { original: true });
  rename.mockImplementationOnce(async () => {
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ original: true });
    throw Object.assign(new Error('Temporarily locked by synchronization'), { code: 'EPERM' });
  });
  await writeCollectorState(statePath, { replacement: true });
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ replacement: true });
  expect(await readdir(directory)).toEqual(['collector-state.json']);
});

test('a process lock rejects another owner until clean release', async () => {
  const release = await acquireCollectorLock(statePath);
  await expect(acquireCollectorLock(statePath)).rejects.toThrow('Another collector lock exists');
  await release();
  const releaseAgain = await acquireCollectorLock(statePath);
  await releaseAgain();
  expect(await readdir(directory)).toEqual([]);
});

test('an unclean lock is preserved rather than raced by multiple recovery processes', async () => {
  const lock = { pid: 999_999_999, host: 'previous-host', token: 'original-lock' };
  await writeFile(`${statePath}.lock`, JSON.stringify(lock));
  await expect(acquireCollectorLock(statePath)).rejects.toThrow('unclean shutdown');
  expect(JSON.parse(await readFile(`${statePath}.lock`, 'utf8'))).toEqual(lock);
});

test('saves exact pending rows before database insertion and keeps a fixed target across restarts', async () => {
  const persistRows = jest.fn(async (rows) => {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(saved.pendingRows).toEqual(rows);
    expect(saved.state.markets[0].contract.target).toBe(100_000);
  });
  const store = await createCollectorStateStore({ statePath, persistRows });
  const initial = await store.advance(input());
  const restarted = await createCollectorStateStore({ statePath, persistRows });
  const result = await restarted.advance(input(start + 181_000, 120_000));
  expect(result.recorderId).toBe(initial.recorderId);
  expect(persistRows).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(statePath, 'utf8')).pendingRows).toEqual([]);
});

test('a database failure preserves original pending evidence and retries it before advancing', async () => {
  const persistRows = jest
    .fn()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValue(undefined);
  const store = await createCollectorStateStore({ statePath, persistRows });
  await expect(store.advance(input())).rejects.toThrow('database unavailable');
  const original = JSON.parse(await readFile(statePath, 'utf8'));
  expect(original.pendingRows).toHaveLength(1);
  const restarted = await createCollectorStateStore({ statePath, persistRows });
  await restarted.advance(input(start + 360_000, 120_000));
  expect(persistRows.mock.calls[1][0]).toEqual(original.pendingRows);
  expect(persistRows.mock.calls[2][0][0]).toMatchObject({
    event: 'decision',
    target: 100_000,
    spot: 120_000,
    capturedAt: start + 360_000,
  });
});

test('rejects corrupted state without overwriting it', async () => {
  await writeFile(statePath, '{incomplete-json');
  await expect(createCollectorStateStore({ statePath, persistRows: jest.fn() })).rejects.toThrow(
    'state is unreadable',
  );
  expect(await readFile(statePath, 'utf8')).toBe('{incomplete-json');
});

test('a failed state write prevents database evidence from being inserted', async () => {
  const persistRows = jest.fn();
  const store = await createCollectorStateStore({ statePath, persistRows });
  await mkdir(statePath);
  await expect(store.advance(input())).rejects.toThrow();
  expect(persistRows).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual(['collector-state.json']);
});

test('a JSON null state file is not mistaken for a missing file and reset', async () => {
  await writeFile(statePath, 'null');
  await expect(createCollectorStateStore({ statePath, persistRows: jest.fn() })).rejects.toThrow(
    'state is unreadable',
  );
  expect(await readFile(statePath, 'utf8')).toBe('null');
});

test('a suspended process cannot backfill a missed capture after restart', async () => {
  const persistRows = jest.fn().mockResolvedValue(undefined);
  const store = await createCollectorStateStore({ statePath, persistRows });
  await store.advance(input());
  const restarted = await createCollectorStateStore({ statePath, persistRows });
  await restarted.advance(input(start + 365_001));
  expect(persistRows.mock.calls[1][0][0]).toMatchObject({
    event: 'decision',
    decision: 'withheld',
    aboveProbability: null,
    inputObservedAt: null,
  });
});

test('rejects state paths outside the data directory and unknown arguments', () => {
  expect(() => parseCollectorOptions(['--state-file=../other.json'], directory)).toThrow(
    'inside the project data directory',
  );
  expect(() => parseCollectorOptions(['--state-file=data'], directory)).toThrow(
    'inside the project data directory',
  );
  expect(() => parseCollectorOptions(['--state-file=data/file.txt'], directory)).toThrow(
    'inside the project data directory',
  );
  expect(() => parseCollectorOptions(['--unrecognized=value'], directory)).toThrow(
    'Unknown collector option',
  );
  expect(
    parseCollectorOptions(['--once', '--state-file=data/check.json'], directory),
  ).toMatchObject({ once: true, statePath: path.join(directory, 'data/check.json') });
});

function getRuntime(time = start + 240_000) {
  const futuresStream = {
    start: jest.fn(),
    stop: jest.fn(),
    getSnapshot: jest.fn(() => ({
      source: 'bybit-linear',
      symbol: 'BTCUSDT',
      status: 'warming',
      asOf: time,
    })),
  };
  const stream = {
    start: jest.fn(),
    stop: jest.fn(),
    getSnapshot: jest.fn(() => ({
      status: 'live',
      ticker: quote(time),
      quality: { confirmedThrough: time },
    })),
    getDeadlineOutcome: jest.fn(() => ({ status: 'waiting' })),
  };
  return {
    stream,
    futuresStream,
    arguments: {
      once: true,
      statePath,
      repository: {
        persistEvidenceRows: jest.fn().mockResolvedValue(undefined),
        getResearchStatus: jest
          .fn()
          .mockResolvedValue({ mode: 'local-database', evidenceCount: 1 }),
      },
      learningService: {
        getLearningStatus: jest.fn().mockResolvedValue({}),
        runLearningCycle: jest.fn().mockResolvedValue({}),
      },
      createStream: () => stream,
      createFuturesStream: () => futuresStream,
      loadTicker: async () => quote(time),
      loadCandles: async () => [],
      loadMarkets: async () => ({ markets: [marketAt(time)] }),
      loadMarket: async () => marketAt(time),
      loadBenchmark: async () => ({ status: 'not-configured', current: null, samples: [] }),
      now: () => time,
      sleep: jest.fn().mockResolvedValue(undefined),
      log: jest.fn(),
    },
  };
}

test('once mode records only the missed Kalshi checkpoint and closes the stream and process lock', async () => {
  const runtime = getRuntime();
  const result = await runResearchCollector(runtime.arguments);
  expect(result.streamStatus).toBe('live');
  const rows = runtime.arguments.repository.persistEvidenceRows.mock.calls.flatMap(
    ([batch]) => batch,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    event: 'decision',
    target: 100_000,
    observedPrice: null,
    aboveProbability: null,
  });
  expect(runtime.stream.start).toHaveBeenCalledTimes(1);
  expect(runtime.stream.stop).toHaveBeenCalledTimes(1);
  expect(runtime.futuresStream.start).toHaveBeenCalledTimes(1);
  expect(runtime.futuresStream.stop).toHaveBeenCalledTimes(1);
  expect(runtime.arguments.learningService.runLearningCycle).not.toHaveBeenCalled();
  expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
});

test('the collector supplies contemporaneous futures inputs to the shared current forecast math', async () => {
  const runtime = getRuntime(start + 180_000);
  await runResearchCollector(runtime.arguments);
  expect(getResearchForecast).toHaveBeenCalledWith(
    expect.objectContaining({ derivatives: runtime.futuresStream.getSnapshot() }),
    expect.any(Object),
    expect.anything(),
  );
  expect(runtime.futuresStream.stop).toHaveBeenCalledTimes(1);
});

test('once mode cannot pass with unavailable market inputs or create fabricated outcomes', async () => {
  const runtime = getRuntime();
  getResearchForecast.mockReturnValue({ available: false });
  await expect(runResearchCollector(runtime.arguments)).rejects.toThrow(
    'could not obtain fresh, valid price and candle inputs',
  );
  expect(runtime.arguments.repository.persistEvidenceRows).not.toHaveBeenCalled();
  expect(runtime.stream.stop).toHaveBeenCalledTimes(1);
  expect(await readdir(directory)).toEqual([]);
});

test('storage failure during a smoke run still closes resources and preserves pending evidence', async () => {
  const runtime = getRuntime();
  runtime.arguments.repository.persistEvidenceRows.mockRejectedValue(new Error('database offline'));
  await expect(runResearchCollector(runtime.arguments)).rejects.toThrow('database offline');
  expect(runtime.stream.stop).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  expect(saved.pendingRows).toHaveLength(1);
  expect(await readdir(directory)).toEqual(['collector-state.json']);
});

test('a termination signal exits a continuous loop and releases owned resources', async () => {
  const runtime = getRuntime();
  const controller = new AbortController();
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    sleep: async () => controller.abort(),
  });
  expect(runtime.stream.stop).toHaveBeenCalledTimes(1);
  expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
});

test('a stale stream ticker falls back to fresh REST for fixed publication and keeps REST refreshing', async () => {
  const seed = await createCollectorStateStore({ statePath, persistRows: async () => {} });
  await seed.advance(input(start));
  const runtime = getRuntime(start + 180_000);
  let observedAt = start + 180_000;
  const controller = new AbortController();
  const loadTicker = jest.fn(async () => quote(observedAt, 101_000));
  runtime.stream.getSnapshot.mockImplementation(() => ({
    status: 'warming',
    ticker: quote(start + 120_000, 99_000),
    quality: { confirmedThrough: start + 120_000 },
  }));
  getResearchForecast.mockImplementation(({ ticker, now }) => ({
    ...getEstimate(),
    available: now - ticker.time <= 20_000,
    pressure: { applied: false },
  }));
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    loadTicker,
    now: () => observedAt,
    sleep: async () => {
      if (observedAt === start + 180_000) observedAt += 6000;
      else controller.abort();
    },
  });
  const rows = runtime.arguments.repository.persistEvidenceRows.mock.calls.flatMap(
    ([batch]) => batch,
  );
  expect(rows.find((row) => row.event === 'decision')).toMatchObject({
    decision: 'pending',
    target: 100_000,
    spot: 101_000,
    aboveProbability: 0.51,
    calculationMode: 'baseline-fallback',
  });
  expect(loadTicker).toHaveBeenCalledTimes(2);
  expect(runtime.stream.stop).toHaveBeenCalledTimes(1);
});

test('a fresh Coinbase quote cannot replace a pending official Kalshi outcome', async () => {
  const seed = await createCollectorStateStore({ statePath, persistRows: async () => {} });
  await seed.advance(input());
  await seed.advance(input(start + 180_000));
  const observedAt = start + 915_001;
  const runtime = getRuntime(observedAt);
  runtime.stream.getSnapshot.mockReturnValue({
    status: 'warming',
    ticker: quote(start + 850_000, 90_000),
    quality: {},
  });
  const controller = new AbortController();
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    loadTicker: async () => quote(observedAt, 110_000),
    sleep: async () => controller.abort(),
  });
  const rows = runtime.arguments.repository.persistEvidenceRows.mock.calls.flatMap(
    ([batch]) => batch,
  );
  expect(rows.some((row) => row.event === 'outcome')).toBe(false);
  expect(runtime.stream.getDeadlineOutcome).not.toHaveBeenCalled();
});

test('the default collector records an actual Kalshi target and checkpoint, with separate state', async () => {
  const time = start + 180_000;
  const runtime = getRuntime(time);
  const market = {
    ticker: 'KXBTC15M-TEST',
    eventTicker: 'KXBTC15M-TEST',
    seriesTicker: 'KXBTC15M',
    target: 99_500,
    startsAt: start,
    expiresAt: start + 900_000,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    status: 'active',
    receivedAt: time,
  };
  getResearchForecast.mockReturnValue({
    ...getEstimate(),
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  });
  await runContractCollector({
    ...runtime.arguments,
    loadMarkets: async () => ({ markets: [market] }),
    loadMarket: jest.fn(),
    loadBenchmark: async () => ({ status: 'not-configured', current: null, samples: [] }),
  });
  const rows = runtime.arguments.repository.persistEvidenceRows.mock.calls.flatMap(
    ([batch]) => batch,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    cohort: 'kalshi-background',
    target: 99_500,
    horizonMinutes: 12,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  });
  expect(rows[0].kalshiMarket.ticker).toBe(market.ticker);
  expect(getResearchForecast).toHaveBeenCalledWith(
    expect.objectContaining({ kalshiMarket: expect.objectContaining({ ticker: market.ticker }) }),
    expect.anything(),
    start,
  );
  expect(parseCollectorOptions([]).statePath).toContain('kalshi-collector-state.json');
});

test('a legacy state file cannot silently run under the new Kalshi collector', async () => {
  await writeCollectorState(statePath, {
    recorderId: 'old-recorder',
    state: { version: 1 },
    pendingRows: [],
  });
  const before = await readFile(statePath, 'utf8');
  await expect(
    createContractStateStore({
      statePath,
      persistRows: async () => {},
    }),
  ).rejects.toThrow('Legacy Coinbase research');
  expect(await readFile(statePath, 'utf8')).toBe(before);
});

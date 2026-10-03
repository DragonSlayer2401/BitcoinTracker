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
import { isCollectorHeartbeat } from '../utils/collectorHealth.utils';

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
  researchExperiment: { version: 'kalshi-ablation-v1', capturedAt: start + 180_000, variants: {} },
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

test('a replaced process lock stops the previous owner before it can replace shared state', async () => {
  const release = await acquireCollectorLock(statePath);
  const persistRows = jest.fn();
  const store = await createCollectorStateStore({
    statePath,
    persistRows,
    assertOwnership: release.assertOwned,
  });
  await writeFile(`${statePath}.lock`, JSON.stringify({ token: 'replacement-owner' }));
  await expect(store.advance(input())).rejects.toMatchObject({ code: 'COLLECTOR_LOCK_LOST' });
  expect(persistRows).not.toHaveBeenCalled();
  await release();
  expect(await readdir(directory)).toEqual(['collector-state.json.lock']);
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

test('paper collection is explicit and reports cannot silently start the experiment', () => {
  expect(parseCollectorOptions([], directory)).toMatchObject({
    paperTrading: false,
    paperReport: false,
  });
  expect(parseCollectorOptions(['--paper-trading'], directory).paperTrading).toBe(true);
  expect(parseCollectorOptions(['--paper-report'], directory)).toMatchObject({
    paperTrading: false,
    paperReport: true,
  });
  for (const argumentsList of [
    ['--paper-trading', '--once'],
    ['--paper-trading', '--report'],
    ['--paper-trading', '--paper-report'],
    ['--paper-report', '--report'],
  ]) {
    expect(() => parseCollectorOptions(argumentsList, directory)).toThrow('continuous collection');
  }
});

test('position-aware advice is opt-in and report commands never start collection', () => {
  expect(parseCollectorOptions([], directory)).toMatchObject({
    tradingAdvisor: false,
    advisorReport: false,
  });
  expect(parseCollectorOptions(['--trading-advisor', '--paper-trading'], directory)).toMatchObject({
    tradingAdvisor: true,
    paperTrading: true,
  });
  expect(parseCollectorOptions(['--advisor-report'], directory)).toMatchObject({
    tradingAdvisor: false,
    advisorReport: true,
  });
  for (const argumentsList of [
    ['--trading-advisor', '--once'],
    ['--trading-advisor', '--report'],
    ['--trading-advisor', '--paper-report'],
    ['--trading-advisor', '--advisor-report'],
    ['--paper-trading', '--advisor-report'],
    ['--paper-report', '--advisor-report'],
  ]) {
    expect(() => parseCollectorOptions(argumentsList, directory)).toThrow('continuous collection');
  }
});

function getRuntime(time = start + 240_000) {
  const benchmarkStream = {
    start: jest.fn(),
    stop: jest.fn(),
    seed: jest.fn(),
    getSnapshot: jest.fn(() => ({ available: false, status: 'warming' })),
  };
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
    benchmarkStream,
    arguments: {
      once: true,
      statePath,
      repository: {
        persistEvidenceRows: jest.fn().mockResolvedValue(undefined),
        getPendingForwardCaptures: jest.fn().mockResolvedValue([]),
        getLearningEvidenceRows: jest.fn().mockResolvedValue([]),
        readModelArtifacts: jest.fn().mockResolvedValue([]),
        getActiveModelArtifact: jest.fn().mockResolvedValue(null),
        getForwardResearchLabels: jest.fn().mockResolvedValue([]),
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
      createBenchmarkStream: () => benchmarkStream,
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

test.each(['paperTradingService', 'tradingAdvisorService'])(
  '%s receives production inputs and shuts down without altering research',
  async (serviceName) => {
    const time = start + 540_000;
    const runtime = getRuntime(time);
    const controller = new AbortController();
    let paperForecast;
    const paperTradingService = {
      advance: jest.fn(async ({ getForecast }) => {
        paperForecast = getForecast();
      }),
      stop: jest.fn(async () => {}),
    };
    await runResearchCollector({
      ...runtime.arguments,
      once: false,
      signal: controller.signal,
      sleep: async () => controller.abort(),
      [serviceName]: paperTradingService,
    });
    expect(paperTradingService.advance).toHaveBeenCalledTimes(1);
    expect(paperForecast).toMatchObject({
      aboveProbability: 0.51,
      capturedAt: time,
      modelVersion: 'test-model',
      researchInputSnapshot: {
        input: { now: time, derivatives: runtime.futuresStream.getSnapshot() },
      },
    });
    expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalled();
    expect(paperTradingService.stop).toHaveBeenCalledWith('stopped');
  },
);

test('an advice failure preserves ordinary research collection and releases the collector lock', async () => {
  const runtime = getRuntime(start + 540_000);
  const controller = new AbortController();
  const tradingAdvisorService = {
    advance: jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('private-database-path'), { code: 'SQLITE_BUSY' }),
      ),
    stop: jest.fn().mockResolvedValue(undefined),
  };
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    sleep: async () => controller.abort(),
    tradingAdvisorService,
  });
  expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalled();
  expect(runtime.arguments.log).toHaveBeenCalledWith(
    expect.stringContaining('Trading adviser could not advance (storage-locked)'),
  );
  expect(JSON.stringify(runtime.arguments.log.mock.calls)).not.toContain('private-database-path');
  expect(tradingAdvisorService.stop).toHaveBeenCalledWith('stopped');
  expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
});

test('a source-ahead stream ticker falls back to an already observed REST price in both capture inputs', async () => {
  const time = start + 180_000;
  const runtime = getRuntime(time);
  const controller = new AbortController();
  runtime.stream.getSnapshot.mockReturnValue({
    status: 'live',
    ticker: { ...quote(time), time: time + 150 },
    quality: { confirmedThrough: time },
  });
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    sleep: async () => controller.abort(),
  });
  expect(getResearchForecast).toHaveBeenCalledWith(
    expect.objectContaining({
      ticker: quote(time),
      stream: expect.objectContaining({ ticker: null }),
    }),
    expect.anything(),
    start,
  );
  const [row] = runtime.arguments.repository.persistEvidenceRows.mock.calls[0][0];
  expect(row.researchInputSnapshot.timing.replayable).toBe(true);
});

test('future optional quotes cannot poison a native BRTI capture or its replay timestamps', async () => {
  const time = start + 180_000;
  const runtime = getRuntime(time);
  const controller = new AbortController();
  const futureTicker = { ...quote(time), time: time + 150 };
  runtime.stream.getSnapshot.mockReturnValue({
    status: 'live',
    ticker: futureTicker,
    quality: { confirmedThrough: time },
  });
  getResearchForecast.mockReturnValue({
    ...getEstimate(),
    kalshi: {
      referenceSource: 'cf-brti',
      referenceAt: time,
      referenceReceivedAt: time,
      referencePrice: 100_000,
    },
  });
  await runResearchCollector({
    ...runtime.arguments,
    loadTicker: async () => futureTicker,
    once: false,
    signal: controller.signal,
    sleep: async () => controller.abort(),
  });
  const [row] = runtime.arguments.repository.persistEvidenceRows.mock.calls[0][0];
  expect(row.decision).toBe('pending');
  expect(row.referenceSource).toBe('cf-brti');
  expect(row.researchInputSnapshot.input.ticker).toBeNull();
  expect(row.researchInputSnapshot.input.stream.ticker).toBeNull();
  expect(row.researchInputSnapshot.timing.replayable).toBe(true);
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

test('durable collector heartbeat is bounded to 30 seconds and records a graceful shutdown', async () => {
  const runtime = getRuntime();
  let time = start + 240_000;
  const controller = new AbortController();
  const writeCollectorHeartbeat = jest.fn().mockResolvedValue(undefined);
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    repository: { ...runtime.arguments.repository, writeCollectorHeartbeat },
    now: () => time,
    sleep: async () => {
      time += 10_000;
      if (time >= start + 310_000) controller.abort();
    },
  });
  const rows = writeCollectorHeartbeat.mock.calls.map(([row]) => row);
  expect(rows.map((row) => row.status)).toEqual([
    'starting',
    'running',
    'running',
    'running',
    'stopped',
  ]);
  expect(rows.map((row) => row.heartbeatAt - rows[0].heartbeatAt)).toEqual([
    0, 0, 30_000, 60_000, 70_000,
  ]);
  expect(rows.every(isCollectorHeartbeat)).toBe(true);
  expect(new Set(rows.map((row) => row.collectorId)).size).toBe(1);
  expect(JSON.stringify(rows)).not.toContain(statePath);
});

test('failed heartbeat writes retry without blocking evidence recording or shutdown', async () => {
  const runtime = getRuntime();
  let time = start + 240_000;
  const controller = new AbortController();
  const writeCollectorHeartbeat = jest
    .fn()
    .mockRejectedValueOnce(new Error('health database busy'))
    .mockResolvedValue(undefined);
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    repository: { ...runtime.arguments.repository, writeCollectorHeartbeat },
    now: () => time,
    sleep: async () => {
      time += 30_000;
      if (time >= start + 300_000) controller.abort();
    },
  });
  expect(writeCollectorHeartbeat).toHaveBeenCalledTimes(4);
  expect(writeCollectorHeartbeat.mock.calls.at(-1)[0].status).toBe('stopped');
  expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalled();
});

test('same-millisecond smoke-run shutdown reports a terminal state using the real clock', async () => {
  const runtime = getRuntime();
  const writeCollectorHeartbeat = jest.fn().mockResolvedValue(undefined);
  await runResearchCollector({
    ...runtime.arguments,
    repository: { ...runtime.arguments.repository, writeCollectorHeartbeat },
  });
  const rows = writeCollectorHeartbeat.mock.calls.map(([row]) => row);
  expect(rows.map((row) => row.status)).toEqual(['starting', 'running', 'stopped']);
  expect(rows[1].heartbeatAt).toBe(rows[0].heartbeatAt);
  expect(rows.every(isCollectorHeartbeat)).toBe(true);
});

test('an unavailable health report cannot fail an otherwise successful smoke run', async () => {
  const runtime = getRuntime();
  const result = await runResearchCollector({
    ...runtime.arguments,
    repository: {
      ...runtime.arguments.repository,
      readCollectorHeartbeats: jest.fn().mockRejectedValue(new Error('heartbeat read failed')),
    },
  });
  expect(result.analysis.collectorHealth).toBeNull();
  expect(result.streamStatus).toBe('live');
  expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalled();
});

test('a pending heartbeat cannot block capture, and shutdown retains ownership until it finishes', async () => {
  const runtime = getRuntime(start + 180_000);
  const result = await runResearchCollector({
    ...runtime.arguments,
    shutdownTimeoutMs: 10,
    repository: {
      ...runtime.arguments.repository,
      writeCollectorHeartbeat: jest.fn(() => new Promise(() => {})),
    },
  });
  expect(result.streamStatus).toBe('live');
  expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(statePath, 'utf8')).pendingRows).toEqual([]);
  expect(await readdir(directory)).toContain('collector-state.json.lock');
});

test('candidate verification cannot delay acknowledging successfully persisted evidence', async () => {
  const runtime = getRuntime(start + 180_000);
  const enrollChallengerCandidates = jest.fn(() => new Promise(() => {}));
  await runResearchCollector({
    ...runtime.arguments,
    shutdownTimeoutMs: 10,
    learningService: { ...runtime.arguments.learningService, enrollChallengerCandidates },
  });
  expect(enrollChallengerCandidates).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(statePath, 'utf8')).pendingRows).toEqual([]);
  expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalledTimes(1);
});

test('an unresolved evidence write times out without overlap or losing the original outbox', async () => {
  const runtime = getRuntime(start + 180_000);
  runtime.arguments.repository.persistEvidenceRows.mockImplementation(() => new Promise(() => {}));
  await expect(
    runResearchCollector({
      ...runtime.arguments,
      operationTimeoutMs: 10,
      shutdownTimeoutMs: 10,
    }),
  ).rejects.toMatchObject({ code: 'COLLECTOR_OPERATION_TIMEOUT' });
  expect(runtime.arguments.repository.persistEvidenceRows).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  expect(saved.pendingRows).toHaveLength(1);
  expect(saved.pendingRows[0].capturedAt).toBe(start + 180_000);
  expect(await readdir(directory)).toContain('collector-state.json.lock');
});

test('temporary storage failures retry their exact pending rows and report safe progress diagnostics', async () => {
  const runtime = getRuntime(start + 180_000);
  let time = start + 180_000;
  const controller = new AbortController();
  const writeCollectorHeartbeat = jest.fn().mockResolvedValue(undefined);
  runtime.arguments.repository.persistEvidenceRows
    .mockRejectedValueOnce(Object.assign(new Error('private-db-path'), { code: 'SQLITE_BUSY' }))
    .mockRejectedValueOnce(Object.assign(new Error('private-db-path'), { code: 'SQLITE_BUSY' }));
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    repository: { ...runtime.arguments.repository, writeCollectorHeartbeat },
    now: () => time,
    sleep: async () => {
      time += 1000;
      if (time >= start + 185_000) controller.abort();
    },
  });
  const calls = runtime.arguments.repository.persistEvidenceRows.mock.calls;
  expect(calls).toHaveLength(3);
  expect(calls[1][0]).toEqual(calls[0][0]);
  expect(calls[2][0]).toEqual(calls[0][0]);
  expect(runtime.arguments.log.mock.calls.flat().join(' ')).toContain('storage-locked');
  expect(runtime.arguments.log.mock.calls.flat().join(' ')).not.toContain('private-db-path');
  expect(writeCollectorHeartbeat.mock.calls.at(-1)[0].progress).toMatchObject({
    lastSuccessfulTickAt: start + 184_000,
    failureCode: null,
    lastFailureAt: start + 181_000,
  });
});

test('an unrecoverable smoke-run error reports a stopped error state and still releases its lock', async () => {
  const runtime = getRuntime();
  getResearchForecast.mockReturnValue({ available: false });
  const writeCollectorHeartbeat = jest.fn().mockResolvedValue(undefined);
  await expect(
    runResearchCollector({
      ...runtime.arguments,
      repository: { ...runtime.arguments.repository, writeCollectorHeartbeat },
    }),
  ).rejects.toThrow('could not obtain fresh');
  expect(writeCollectorHeartbeat.mock.calls.at(-1)[0].status).toBe('error');
  expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
});

test('healthy BRTI streaming reduces REST polling and preserves startup history seeding', async () => {
  const runtime = getRuntime();
  let time = start + 240_000;
  const controller = new AbortController();
  runtime.benchmarkStream.getSnapshot.mockImplementation(() => ({
    available: true,
    transport: 'kalshi-websocket',
    samples: [],
    receivedAt: time,
  }));
  const loadBenchmark = jest.fn().mockResolvedValue({ samples: [], receivedAt: time });
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    loadBenchmark,
    now: () => time,
    sleep: async () => {
      time += 10_000;
      if (time >= start + 295_000) controller.abort();
    },
  });
  expect(loadBenchmark).toHaveBeenCalledTimes(1);
  expect(runtime.benchmarkStream.seed).toHaveBeenCalledTimes(1);
  expect(runtime.benchmarkStream.stop).toHaveBeenCalledTimes(1);
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

async function savePendingContract() {
  const decisions = [];
  const store = await createCollectorStateStore({
    statePath,
    persistRows: async (rows) => decisions.push(...rows),
  });
  for (const remainingMinutes of [12, 9, 6, 3, 1]) {
    const capturedAt = start + 900_000 - remainingMinutes * 60_000;
    await store.advance({
      ...input(capturedAt),
      getEstimate: () => ({
        ...getEstimate(),
        aboveProbability: 0.5 + remainingMinutes / 100,
        belowProbability: 0.5 - remainingMinutes / 100,
      }),
    });
  }
  expect(decisions).toHaveLength(5);
  expect(decisions.every((row) => row.event === 'decision' && row.decision === 'pending')).toBe(
    true,
  );
  return { decisions, state: store.getState() };
}

const afterSettlementRetention = start + 900_000 + 8 * 24 * 60 * 60_000;

test.each([
  ['absent', () => []],
  ['stale', (now) => [marketAt(now - 60_001)]],
  ['a different target', (now) => [marketAt(now, 99_000)]],
  [
    'a different contract',
    (now) => [{ ...marketAt(now), ticker: 'KXBTC15M-OTHER', eventTicker: 'KXBTC15M-OTHER' }],
  ],
  [
    'future dated',
    (now) => [
      { ...marketAt(now + 1), status: 'finalized', result: 'yes', settlementPrice: 100_010 },
    ],
  ],
  ['without a receipt time', () => [{ ...marketAt(start), receivedAt: null }]],
])(
  'a restarted old pending contract is retained when the market response is %s',
  async (_, getMarkets) => {
    const { state } = await savePendingContract();
    const persistRows = jest.fn().mockResolvedValue(undefined);
    const restarted = await createCollectorStateStore({ statePath, persistRows });
    const estimate = jest.fn();
    const result = await restarted.advance({
      now: afterSettlementRetention,
      markets: getMarkets(afterSettlementRetention),
      ticker: quote(afterSettlementRetention, 120_000),
      getEstimate: estimate,
    });
    expect(result.status.phase).toBe('settling');
    expect(result.rowsWritten).toBe(0);
    expect(restarted.getState()).toEqual(state);
    expect(persistRows).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
  },
);

test('an old pending contract resolves from a fresh official result without rewriting its decisions', async () => {
  const { decisions, state } = await savePendingContract();
  const originalDecisions = JSON.parse(JSON.stringify(decisions));
  const persistRows = jest.fn().mockResolvedValue(undefined);
  const restarted = await createCollectorStateStore({ statePath, persistRows });
  const estimate = jest.fn();
  await restarted.advance({ now: afterSettlementRetention, markets: [], getEstimate: estimate });
  expect(restarted.getState()).toEqual(state);
  await restarted.advance({
    now: afterSettlementRetention + 1000,
    markets: [
      {
        ...marketAt(afterSettlementRetention + 1000),
        status: 'finalized',
        result: 'yes',
        settlementPrice: 100_010,
      },
    ],
    ticker: quote(afterSettlementRetention + 1000, 80_000),
    getEstimate: estimate,
  });
  const outcomes = persistRows.mock.calls.flatMap(([rows]) => rows);
  expect(outcomes).toHaveLength(5);
  for (const original of decisions) {
    expect(outcomes.find((row) => row.forecastId === original.forecastId)).toMatchObject({
      event: 'outcome',
      decision: 'resolved',
      outcomeStatus: 'observed',
      outcome: 'above',
      observedPrice: 100_010,
      observedAt: original.expiresAt,
      aboveProbability: original.aboveProbability,
      belowProbability: original.belowProbability,
      target: original.target,
      capturedAt: original.capturedAt,
      modelVersion: original.modelVersion,
    });
  }
  expect(decisions).toEqual(originalDecisions);
  expect(estimate).not.toHaveBeenCalled();
  expect(restarted.getState().markets).toEqual([]);
  expect(restarted.getState().completed).toEqual([
    { ticker: marketAt(start).ticker, expiresAt: start + 900_000 },
  ]);
});

test('the seven-day unresolved timeout still applies after a fresh matching nonfinal response', async () => {
  const { decisions } = await savePendingContract();
  const persistRows = jest.fn().mockResolvedValue(undefined);
  const restarted = await createCollectorStateStore({ statePath, persistRows });
  await restarted.advance({
    now: afterSettlementRetention,
    markets: [{ ...marketAt(afterSettlementRetention - 60_000), status: 'closed' }],
    getEstimate: jest.fn(),
  });
  const outcomes = persistRows.mock.calls.flatMap(([rows]) => rows);
  expect(outcomes).toHaveLength(5);
  for (const original of decisions) {
    expect(outcomes.find((row) => row.forecastId === original.forecastId)).toMatchObject({
      event: 'outcome',
      decision: 'unobserved',
      outcomeStatus: 'unobserved',
      outcome: null,
      observedPrice: null,
      aboveProbability: original.aboveProbability,
      target: original.target,
      capturedAt: original.capturedAt,
    });
  }
  expect(restarted.getState().markets).toEqual([]);
});

test('collector restart fetches a pending old contract before applying any settlement timeout', async () => {
  const { decisions } = await savePendingContract();
  const runtime = getRuntime(afterSettlementRetention);
  const controller = new AbortController();
  const loadMarket = jest.fn(async (ticker) => {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    expect(ticker).toBe(marketAt(start).ticker);
    expect(saved.state.markets[0].checkpoints.every((entry) => entry.status === 'pending')).toBe(
      true,
    );
    return {
      ...marketAt(afterSettlementRetention),
      status: 'finalized',
      result: 'yes',
      settlementPrice: 100_010,
    };
  });
  let ticks = 0;
  await runResearchCollector({
    ...runtime.arguments,
    once: false,
    signal: controller.signal,
    loadMarkets: async () => ({ markets: [] }),
    loadMarket,
    sleep: async () => {
      if (++ticks === 1) await Promise.all(loadMarket.mock.results.map((result) => result.value));
      else controller.abort();
    },
  });
  expect(loadMarket).toHaveBeenCalledTimes(1);
  const outcomes = runtime.arguments.repository.persistEvidenceRows.mock.calls.flatMap(
    ([rows]) => rows,
  );
  expect(outcomes).toHaveLength(5);
  expect(outcomes.every((row) => row.event === 'outcome' && row.outcomeStatus === 'observed')).toBe(
    true,
  );
  for (const original of decisions) {
    expect(outcomes.find((row) => row.forecastId === original.forecastId)).toMatchObject({
      decision: 'resolved',
      aboveProbability: original.aboveProbability,
      belowProbability: original.belowProbability,
      target: original.target,
      capturedAt: original.capturedAt,
    });
  }
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

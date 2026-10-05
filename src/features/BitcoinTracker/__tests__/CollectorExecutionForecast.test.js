/** @jest-environment node */
import { runResearchCollector } from '../../../../scripts/collect-research.runtime';
import { createCollectorStateStore } from '../../../../scripts/collect-research.storage';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('server-only', () => ({}));
jest.mock('@libsql/client', () => ({ createClient: jest.fn() }));
jest.mock('../../../../scripts/collect-research.storage', () => ({
  acquireCollectorLock: jest.fn(async () => jest.fn()),
  createCollectorStateStore: jest.fn(),
  writeCollectorState: jest.fn(),
}));
jest.mock('../utils/researchForecast.utils', () => ({ getResearchForecast: jest.fn() }));

const start = 1_800_000_000_000;
const observedAt = start + 180_000;
const tickerAt = (time, price = 100_000) => ({ time, receivedAt: time, price });
const market = {
  ticker: 'KXBTC15M-CURRENT',
  eventTicker: 'KXBTC15M-CURRENT',
  seriesTicker: 'KXBTC15M',
  target: 100_000,
  startsAt: start,
  expiresAt: start + 900_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
  receivedAt: observedAt,
  yesBid: 0.913,
  yesAsk: 0.92,
  noBid: 0.08,
  noAsk: 0.087,
};
const bookAt = (time, contract = market) => ({
  ticker: contract.ticker,
  requestedAt: time - 100,
  receivedAt: time,
  yesAsks: [{ price: 0.63, quantity: 100 }],
  noAsks: [{ price: 0.38, quantity: 100 }],
  fee: {
    available: true,
    type: 'quadratic',
    multiplier: 1,
    checkedAt: time,
    validUntil: time + 30_000,
  },
});
const createFeed = (getSnapshot) => ({
  start: jest.fn(),
  stop: jest.fn(),
  seed: jest.fn(),
  getSnapshot: jest.fn(getSnapshot),
});

function createRuntime() {
  const controller = new AbortController();
  const stream = createFeed((time) => ({
    status: 'live',
    ticker: tickerAt(time, 100_000 + (time - observedAt) / 1000),
    quality: { confirmedThrough: time },
  }));
  const benchmarkStream = createFeed((time) => ({
    available: true,
    receivedAt: time,
    current: tickerAt(time, 100_100 + (time - observedAt) / 1000),
    samples: [tickerAt(time)],
  }));
  const futuresStream = createFeed((time) => ({ asOf: time, quality: { lastTradeAt: time } }));
  const candles = [{ time: start - 60_000, close: 99_000 }];
  return {
    controller,
    stream,
    benchmarkStream,
    futuresStream,
    candles,
    arguments: {
      statePath: 'unused-mocked-state.json',
      repository: {},
      learningService: { getResearchModels: async () => ({}) },
      signal: controller.signal,
      createStream: () => stream,
      createFuturesStream: () => futuresStream,
      createBenchmarkStream: () => benchmarkStream,
      loadTicker: async () => tickerAt(observedAt),
      loadCandles: async () => candles,
      loadMarkets: async () => ({ markets: [market] }),
      loadBenchmark: async () => ({ available: false, current: null, samples: [] }),
      now: () => observedAt,
      sleep: async () => controller.abort(),
      log: jest.fn(),
    },
  };
}

beforeEach(() => {
  createCollectorStateStore.mockResolvedValue({
    advance: async () => ({ status: { phase: 'waiting' }, rowsWritten: 0 }),
    getState: () => ({ markets: [] }),
  });
  getResearchForecast.mockImplementation((input) => ({
    available: true,
    aboveProbability: 0.99,
    belowProbability: 0.01,
    modelVersion: 'collector-test',
    researchExperiment: {
      version: 'kalshi-ablation-v1',
      capturedAt: input.now,
      variants: {},
    },
  }));
});

test('recaptures live sources and the supplied execution contract while no-argument captures keep the original tick', async () => {
  const runtime = createRuntime();
  const receivedAt = observedAt + 1200;
  const contract = { ...market, ticker: 'KXBTC15M-ENTERED', target: 101_000 };
  const book = bookAt(receivedAt, contract);
  let initial;
  let recaptured;
  let originalAfterRecapture;
  await runResearchCollector({
    ...runtime.arguments,
    tradingAdvisorService: {
      advance: async ({ getForecast }) => {
        initial = getForecast();
        await Promise.resolve();
        recaptured = getForecast({ contract, book, now: receivedAt });
        originalAfterRecapture = getForecast();
      },
      stop: jest.fn(),
    },
  });

  expect(recaptured.available).toBe(true);
  expect(recaptured.researchInputSnapshot).toMatchObject({
    capturedAt: receivedAt,
    windowStartAt: contract.startsAt,
    input: {
      now: receivedAt,
      target: contract.target,
      kalshiMarket: contract,
      ticker: tickerAt(receivedAt, 100_001.2),
      benchmark: { current: tickerAt(receivedAt, 100_101.2) },
      derivatives: { asOf: receivedAt },
      kalshiQuote: {
        marketTicker: contract.ticker,
        target: contract.target,
        receivedAt,
        yesBid: 0.62,
        yesAsk: 0.63,
      },
    },
    timing: { replayable: true },
  });
  expect(initial.researchInputSnapshot.input.kalshiQuote.yesAsk).toBe(0.92);
  expect(originalAfterRecapture).toEqual(initial);
  for (const feed of [runtime.stream, runtime.benchmarkStream, runtime.futuresStream]) {
    expect(feed.getSnapshot).toHaveBeenCalledWith(receivedAt);
  }
});

test('an invalid execution book cannot silently reuse the research market quote', async () => {
  const runtime = createRuntime();
  let forecast;
  await runResearchCollector({
    ...runtime.arguments,
    tradingAdvisorService: {
      advance: async ({ getForecast }) => {
        forecast = getForecast({
          contract: market,
          book: { ...bookAt(observedAt), ticker: 'KXBTC15M-OTHER' },
          now: observedAt,
        });
      },
      stop: jest.fn(),
    },
  });
  expect(forecast.researchInputSnapshot.input.kalshiQuote).toBeNull();
  expect(getResearchForecast).toHaveBeenCalledWith(
    expect.objectContaining({ kalshiQuote: null }),
    {},
    start,
  );
});

test('independent pattern collection retains captured features when production has no entry', async () => {
  const runtime = createRuntime();
  const production = { advance: jest.fn(async () => ({ status: 'skipped' })), stop: jest.fn() };
  const patterns = {
    chartPatterns: { version: 'brti-patterns-v2', capturedAt: observedAt },
    patternLearningFeatures: {
      schemaVersion: 'deadline-pattern-features-v5',
      featureCutoffAt: observedAt,
    },
    patternShadowPredictions: [],
  };
  getResearchForecast.mockReturnValue({
    available: true,
    aboveProbability: 0.5,
    belowProbability: 0.5,
    modelVersion: 'collector-test',
    ...patterns,
    researchExperiment: { version: 'kalshi-ablation-v1', capturedAt: observedAt, variants: {} },
  });
  let captured;
  const patternResearchService = {
    advance: jest.fn(async ({ getForecast }) => {
      captured = getForecast();
    }),
    stop: jest.fn(),
  };
  await runResearchCollector({
    ...runtime.arguments,
    paperTradingService: production,
    patternResearchService,
  });
  expect(production.advance).toHaveBeenCalled();
  expect(patternResearchService.advance).toHaveBeenCalled();
  expect(captured.aboveProbability).toBe(0.5);
  expect(captured.researchInputSnapshot).toMatchObject({
    capturedAt: observedAt,
    expectedPatterns: patterns,
    timing: { replayable: true },
  });
  expect(patternResearchService.stop).toHaveBeenCalledTimes(1);
});

test.each([
  ['future source', { time: observedAt + 1 }],
  ['future receipt', { receivedAt: observedAt + 1 }],
  ['missing source', { time: undefined }],
  ['null source', { time: null }],
  ['null receipt', { receivedAt: null }],
])('excludes a %s REST ticker from a current capture', async (description, overrides) => {
  const runtime = createRuntime();
  runtime.stream.getSnapshot.mockReturnValue({ status: 'warming', ticker: null });
  let forecast;
  await runResearchCollector({
    ...runtime.arguments,
    loadTicker: async () => ({ ...tickerAt(observedAt), ...overrides }),
    tradingAdvisorService: {
      advance: async ({ getForecast }) => {
        forecast = getForecast({ contract: market, book: bookAt(observedAt), now: observedAt });
      },
      stop: jest.fn(),
    },
  });
  expect(forecast.researchInputSnapshot.input.ticker).toBeNull();
  expect(forecast.researchInputSnapshot.input.stream.ticker).toBeNull();
  expect(forecast.researchInputSnapshot.timing.replayable).toBe(true);
});

test('recapture reads refreshed REST and candle inputs while excluding future candle observations', async () => {
  const runtime = createRuntime();
  runtime.stream.getSnapshot.mockReturnValue({ status: 'warming', ticker: null });
  let time = observedAt;
  let getCapturedForecast;
  let recaptured;
  let releaseAdvance;
  const validCandle = { time: observedAt - 60_000, close: 100_010 };
  const currentCandles = [
    validCandle,
    { time: observedAt + 32_000, close: 100_020 },
    { time: start, receivedAt: observedAt + 32_000, close: 100_030 },
  ];
  const loadCandles = jest
    .fn()
    .mockResolvedValueOnce(runtime.candles)
    .mockResolvedValue(currentCandles);
  await runResearchCollector({
    ...runtime.arguments,
    now: () => time,
    loadTicker: async () => tickerAt(time, time === observedAt ? 100_000 : 100_050),
    loadCandles,
    tradingAdvisorService: {
      advance: async ({ getForecast }) => {
        getCapturedForecast = getForecast;
        await new Promise((resolve) => {
          releaseAdvance = resolve;
        });
      },
      stop: jest.fn(),
    },
    sleep: async () => {
      if (time === observedAt) {
        time += 31_000;
        return;
      }
      await Promise.resolve();
      recaptured = getCapturedForecast({ contract: market, book: bookAt(time), now: time });
      releaseAdvance();
      runtime.controller.abort();
    },
  });
  expect(loadCandles).toHaveBeenCalledTimes(2);
  expect(recaptured.researchInputSnapshot.input).toMatchObject({
    now: observedAt + 31_000,
    ticker: tickerAt(observedAt + 31_000, 100_050),
    candles: [validCandle],
  });
  expect(recaptured.researchInputSnapshot.timing.replayable).toBe(true);
});

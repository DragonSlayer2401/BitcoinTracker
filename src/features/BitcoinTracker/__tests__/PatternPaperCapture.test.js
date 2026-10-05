/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createPatternResearchRepository } from '../../../services/research/patterns/patternResearch.repository';
import { createPatternResearchService } from '../../../services/research/patterns/patternResearch.service';
import { getKalshiContract, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { PAPER_TRADING_POLICY } from '../features/PaperTrading/utils/paperTrading.utils';

jest.mock('server-only', () => ({}));

const START = Date.UTC(2026, 9, 4, 12);
const CHECKPOINT = START + (15 - PAPER_TRADING_POLICY.checkpointMinutes) * 60_000;
const market = {
  ticker: 'KXBTC15M-PATTERN-TEST',
  eventTicker: 'KXBTC15M-PATTERN-TEST',
  seriesTicker: 'KXBTC15M',
  startsAt: START,
  expiresAt: START + 15 * 60_000,
  target: 100_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  status: 'active',
  receivedAt: CHECKPOINT,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
const contract = getKalshiContract(market);
const clone = (value) => JSON.parse(JSON.stringify(value));
const row = (stage, extra = {}) => ({
  id: `${market.ticker}:${stage}`,
  ticker: market.ticker,
  contract,
  stage,
  recordedAt: CHECKPOINT,
  ...extra,
});
const bookAt = (receivedAt, price = 0.54) => ({
  available: true,
  ticker: market.ticker,
  receivedAt,
  yesAsks: [{ price, quantity: 5 }],
  noAsks: [{ price: 1.01 - price, quantity: 5 }],
  fee: { available: true, multiplier: 0.07, type: 'quadratic' },
  depthLimit: 100,
});

let client;
let repository;
let clock;
beforeEach(() => {
  client = createClient({ url: 'file::memory:' });
  repository = createPatternResearchRepository({ client });
  clock = CHECKPOINT;
});
afterEach(() => client.close());

function service(overrides = {}) {
  const loadBook = jest.fn(async () => bookAt(clock));
  return {
    loadBook,
    recorder: createPatternResearchService({
      repository,
      now: () => clock,
      loadBook,
      ...overrides,
    }),
  };
}

test.each([
  ['weak', { available: true, aboveProbability: 0.5 }],
  ['unavailable', { available: false, aboveProbability: null }],
])(
  'captures both books for a %s forecast without a trade-intent or pattern-confirmation gate',
  async (_, estimate) => {
    const patterns = [{ modelId: 'shadow-test', aboveProbability: 0.61 }];
    const getForecast = jest.fn(() => ({
      ...estimate,
      capturedAt: clock,
      researchInputSnapshot: {
        models: {
          patterns: { suites: [{ suiteId: 'registered-suite', registeredAt: START - 1 }] },
        },
        expectedPatterns: {
          patternShadowPredictions: patterns,
          patternLearningFeatures: { schemaVersion: 'fixture', values: [0] },
        },
      },
    }));
    const { recorder, loadBook } = service();
    await recorder.advance({ market, getForecast });
    let stages = await repository.readStages(market.ticker);
    expect(stages.claim.forecast.available).toBe(estimate.available);
    expect(stages.claim.version).toBe('pattern-paper-observation-v2');
    expect(stages.claim.patternSuites).toEqual([
      { suiteId: 'registered-suite', registeredAt: START - 1 },
    ]);
    expect(stages.claim.patternShadowPredictions).toEqual(patterns);
    expect(stages.initial.book).toMatchObject({
      yesAsks: [{ quantity: 5 }],
      noAsks: [{ quantity: 5 }],
    });
    expect(stages.execution).toBeUndefined();
    expect(getForecast).toHaveBeenCalledTimes(1);
    expect(loadBook).toHaveBeenCalledTimes(1);

    patterns[0].aboveProbability = 0.99;
    clock += PAPER_TRADING_POLICY.minimumFillDelayMs - 1;
    await recorder.advance({ market, getForecast });
    expect(loadBook).toHaveBeenCalledTimes(1);
    clock += 1;
    await recorder.advance({ market, getForecast });
    await recorder.advance({ market, getForecast });
    stages = await repository.readStages(market.ticker);
    expect(loadBook).toHaveBeenCalledTimes(2);
    expect(stages.execution.observedAt - stages.initial.observedAt).toBe(
      PAPER_TRADING_POLICY.minimumFillDelayMs,
    );
    expect(stages.execution.book.requestedAt).toBe(clock);
    expect(stages.claim.patternShadowPredictions[0].aboveProbability).toBe(0.61);
    const restarted = createPatternResearchRepository({ client });
    const [captured] = await restarted.readPaperObservations();
    expect(captured.source).toBe('pattern-independent');
    expect(captured.initial).toEqual(stages.initial);
    expect(captured.execution).toEqual(stages.execution);
  },
);

test('a claimed initial request lost during restart becomes missing coverage without another request', async () => {
  await repository.claim(row('claim', { capturedAt: clock, forecast: { available: false } }));
  const restarted = createPatternResearchRepository({ client });
  const { recorder, loadBook } = service({ repository: restarted });
  const getForecast = jest.fn();
  await recorder.advance({ market, getForecast });
  expect((await restarted.readStages(market.ticker)).initial).toBeUndefined();
  clock += PAPER_TRADING_POLICY.maximumFillDelayMs + 1;
  await recorder.advance({ market, getForecast });
  const stages = await restarted.readStages(market.ticker);
  expect(stages.initial).toMatchObject({ book: null, requestedAt: null, observedAt: CHECKPOINT });
  expect(stages.execution).toMatchObject({ book: null, requestedAt: null });
  expect(loadBook).not.toHaveBeenCalled();
  expect(getForecast).not.toHaveBeenCalled();
});

test('a delayed request claimed before restart is never retried for a different execution price', async () => {
  const initial = service();
  await initial.recorder.advance({
    market,
    getForecast: () => ({ available: true, aboveProbability: 0.8 }),
  });
  clock += PAPER_TRADING_POLICY.minimumFillDelayMs;
  await repository.claim(row('delay-claim', { recordedAt: clock }));
  const restarted = service({ repository: createPatternResearchRepository({ client }) });
  await restarted.recorder.advance({ market, getForecast: jest.fn() });
  expect((await repository.readStages(market.ticker)).execution).toBeUndefined();
  clock += PAPER_TRADING_POLICY.maximumFillDelayMs + 1;
  await restarted.recorder.advance({ market, getForecast: jest.fn() });
  expect((await repository.readStages(market.ticker)).execution).toMatchObject({
    book: null,
    requestedAt: null,
  });
  expect(restarted.loadBook).not.toHaveBeenCalled();
});

test.each([false, true])(
  'a pending save retries its exact frozen result after committed=%s failure',
  async (committed) => {
    const frozenBook = bookAt(clock);
    const loadBook = jest.fn(async () => frozenBook);
    const savedPayloads = [];
    let fail = true;
    const storage = {
      ...repository,
      async save(value) {
        savedPayloads.push(clone(value));
        if (fail) {
          fail = false;
          if (committed) await repository.save(value);
          throw new Error('Unknown storage outcome');
        }
        return repository.save(value);
      },
    };
    const { recorder } = service({ repository: storage, loadBook });
    const getForecast = jest.fn(() => ({
      available: true,
      aboveProbability: 0.6,
      capturedAt: clock,
    }));
    await expect(recorder.advance({ market, getForecast })).rejects.toThrow(
      'Unknown storage outcome',
    );
    frozenBook.yesAsks[0].price = 0.01;
    frozenBook.receivedAt = clock + 1000;
    clock += 1000;
    await recorder.advance({ market, getForecast });
    const stages = await repository.readStages(market.ticker);
    expect(savedPayloads).toHaveLength(2);
    expect(savedPayloads[1]).toEqual(savedPayloads[0]);
    expect(stages.initial.book.yesAsks[0].price).toBe(0.54);
    expect(stages.initial.observedAt).toBe(CHECKPOINT);
    expect(getForecast).toHaveBeenCalledTimes(1);
    expect(loadBook).toHaveBeenCalledTimes(1);
  },
);

test('duplicate payloads are idempotent and a different payload cannot overwrite history', async () => {
  const claim = row('claim', { forecast: { available: true, aboveProbability: 0.6 } });
  expect(await repository.claim(claim)).toBe(true);
  expect(
    await repository.claim({ ...claim, forecast: { available: true, aboveProbability: 0.9 } }),
  ).toBe(false);
  const initial = row('initial', { observedAt: clock, requestedAt: clock, book: bookAt(clock) });
  expect(await repository.save(initial)).toBe(true);
  expect(await repository.save(clone(initial))).toBe(false);
  await expect(repository.save({ ...initial, book: bookAt(clock, 0.01) })).rejects.toMatchObject({
    status: 409,
  });
  const stored = await repository.readStages(market.ticker);
  expect(stored.claim).toEqual(claim);
  expect(stored.initial).toEqual(initial);
});

test('a missed checkpoint retains explicit missing coverage without capturing a later forecast or book', async () => {
  clock += PAPER_TRADING_POLICY.captureGraceMs + 1;
  const getForecast = jest.fn();
  const { recorder, loadBook } = service();
  await recorder.advance({ market, getForecast });
  clock += PAPER_TRADING_POLICY.minimumFillDelayMs;
  await recorder.advance({ market, getForecast });
  const [observation] = await repository.readPaperObservations();
  expect(observation.forecast.available).toBe(false);
  expect(observation.initial.book).toBeNull();
  expect(observation.execution.book).toBeNull();
  expect(getForecast).not.toHaveBeenCalled();
  expect(loadBook).not.toHaveBeenCalled();
});

test('failed book requests are retained without favorable retries and reads never request prices', async () => {
  const loadBook = jest.fn().mockRejectedValue(new Error('Unavailable order book'));
  const { recorder } = service({ loadBook });
  await recorder.advance({
    market,
    getForecast: () => ({ available: true, aboveProbability: 0.7 }),
  });
  clock += PAPER_TRADING_POLICY.minimumFillDelayMs;
  await recorder.advance({ market, getForecast: jest.fn() });
  const [observation] = await repository.readPaperObservations();
  expect(observation.initial.book).toBeNull();
  expect(observation.execution.book).toBeNull();
  expect(loadBook).toHaveBeenCalledTimes(1);
  expect(await repository.readPaperObservations()).toEqual([observation]);
});

test('concurrent service advances share one capture and preserved rows detect tampering', async () => {
  const { recorder, loadBook } = service();
  const getForecast = jest.fn(() => ({ available: true, aboveProbability: 0.5 }));
  await Promise.all(Array.from({ length: 4 }, () => recorder.advance({ market, getForecast })));
  expect(getForecast).toHaveBeenCalledTimes(1);
  expect(loadBook).toHaveBeenCalledTimes(1);
  await client.execute({
    sql: 'UPDATE pattern_paper_observations SET payload = ? WHERE id = ?',
    args: [
      JSON.stringify(row('initial', { book: bookAt(clock, 0.01) })),
      `${market.ticker}:initial`,
    ],
  });
  await expect(repository.readPaperObservations()).rejects.toMatchObject({ status: 409 });
});

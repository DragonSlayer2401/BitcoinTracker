/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { replayResearchInputSnapshot } from '../../../utils/researchExperiments.utils';
import { createAdvisorForecast, getAdvisorBookQuote } from '../utils/advisorForecast.utils';
import { TRADING_ADVISOR_POLICY } from '../utils/tradingAdvisor.utils';
import { START, contract, bookAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });

let client;
let repository;
let service;
let clock;
let referencePrice;
let loadBook;
let getForecast;
const policy = TRADING_ADVISOR_POLICY;
const market = { ...contract, receivedAt: START + 540000, yesBid: 0.913, yesAsk: 0.92 };
const entryBook = (now) => ({
  ...bookAt(now),
  yesAsks: [{ price: 0.63, quantity: 100 }],
  noAsks: [{ price: 0.38, quantity: 100 }],
});

function capture(options) {
  const now = options?.now ?? clock;
  const second = Math.floor(now / 1000) * 1000;
  const selected = options?.contract ?? market;
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: second - (1200 - index) * 1000,
    receivedAt: second - (1200 - index) * 1000,
    price: referencePrice * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
  }));
  return createAdvisorForecast(
    {
      now,
      kalshiMarket: selected,
      ...(options
        ? { kalshiQuote: getAdvisorBookQuote({ contract: selected, book: options.book, now }) }
        : {}),
      benchmark: { status: 'live', samples, current: samples.at(-1), receivedAt: now },
      stream: {
        status: 'disconnected',
        flow: { available: false },
        liquidity: { available: false },
        quality: {},
      },
    },
    {},
    selected.startsAt,
  );
}

const advance = (extra = {}) => service.advance({ market, getForecast, ...extra });

beforeEach(() => {
  clock = START + 540000;
  referencePrice = 76000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  loadBook = jest.fn(async () => entryBook(clock));
  getForecast = jest.fn(capture);
  service = createTradingAdvisorService({ repository, loadBook, now: () => clock });
});
afterEach(() => client.close());

test('records the 99/91.65/62.5 disagreement and replays the same decision book', async () => {
  await advance();
  const state = await repository.readState(policy.id);
  const saved = await repository.readAdvice(state.advice[0].id, { includeInputs: true });
  expect(saved.action).toBe('buy');
  expect(saved.forecastReconciliation).toMatchObject({
    recomputed: true,
    sameExecutionBook: true,
    largeDisagreement: true,
    executionBookProbability: 0.625,
    originalForecast: { aboveProbability: 0.99 },
    currentForecast: { aboveProbability: 0.99 },
  });
  expect(saved.forecastReconciliation.originalResearchMarketProbability).toBeCloseTo(0.9165);
  expect(saved.forecastReconciliation.gaps.originalForecastToExecutionBook).toBeCloseTo(0.365);
  expect(saved.forecastReconciliation.gaps.researchMarketToExecutionBook).toBeCloseTo(0.2915);
  const replay = replayResearchInputSnapshot(saved.forecast.researchInputSnapshot);
  expect(replay.researchExperiment.variants['market-only'].aboveProbability).toBe(0.625);
  expect(replay.researchExperiment.variants['market-blend'].marketProbability).toBe(0.625);
  expect(state.advice[0].forecastReconciliation).toEqual(saved.forecastReconciliation);
});

test('a price change while awaiting the book changes the production decision with current inputs', async () => {
  loadBook.mockImplementationOnce(async () => {
    clock += 600;
    referencePrice = contract.target;
    return entryBook(clock);
  });
  await advance();
  const state = await repository.readState(policy.id);
  expect(state.advice[0]).toMatchObject({ action: 'buy', side: 'no' });
  expect(state.advice[0].forecastReconciliation).toMatchObject({
    recomputed: true,
    originalForecast: { aboveProbability: 0.99, capturedAt: clock - 600 },
    currentForecast: { capturedAt: clock, referenceAt: clock - 600 },
  });
  expect(state.advice[0].forecastReconciliation.currentForecast.aboveProbability).toBeLessThan(0.6);
  expect(getForecast).toHaveBeenCalledTimes(2);
  expect(getForecast.mock.calls[1][0].book).toMatchObject({ receivedAt: clock });
});

test('delayed execution freezes current forecast inputs and values without rewriting the order', async () => {
  await advance();
  const advice = (await repository.readState(policy.id)).advice[0];
  clock += 2000;
  referencePrice = contract.target;
  await advance({ market: null });
  const event = await repository.readExecution(`${advice.id}:execution`, { includeInputs: true });
  expect(event).toMatchObject({
    kind: 'fill',
    probability: 0.99,
    forecastReconciliation: { recomputed: true, sameExecutionBook: true },
  });
  expect(event.forecast.aboveProbability).toBeLessThan(0.6);
  expect(event.forecastValuesAtFill.refreshedProduction.expectedNetValue).toBeLessThan(0);
  expect(event.expectedNetValueAtFill).toBeGreaterThan(0);
  expect(event.forecastValuesAtFill.executionMidpoint.expectedNetValue).toBeCloseTo(
    0.625 * event.quantity - event.totalCost,
    8,
  );
  expect(replayResearchInputSnapshot(event.researchInputSnapshot).aboveProbability).toBe(
    event.forecast.aboveProbability,
  );
  expect(getForecast.mock.calls.at(-1)[0].contract).toEqual(contract);
  const calls = getForecast.mock.calls.length;
  await service.getReport();
  expect(getForecast).toHaveBeenCalledTimes(calls);
  expect(loadBook).toHaveBeenCalledTimes(2);
});

test('retry reuses the exact execution forecast and archive after the market changes again', async () => {
  await advance();
  const advice = (await repository.readState(policy.id)).advice[0];
  const saveExecution = repository.saveExecution;
  const save = jest
    .spyOn(repository, 'saveExecution')
    .mockRejectedValueOnce(new Error('write failed'));
  clock += 2000;
  await expect(advance()).rejects.toThrow('write failed');
  const frozen = save.mock.calls[0][0];
  const captures = getForecast.mock.calls.length;
  save.mockImplementation(saveExecution);
  clock += 1000;
  referencePrice = 74000;
  await advance({ allowNewAdvice: false });
  expect(getForecast).toHaveBeenCalledTimes(captures);
  expect(loadBook).toHaveBeenCalledTimes(2);
  const saved = await repository.readExecution(`${advice.id}:execution`, { includeInputs: true });
  expect(saved.forecast).toEqual(frozen.forecast);
  expect(saved.researchInputSnapshot).toEqual(frozen.researchInputSnapshot);
  const lease = await repository.acquireLease(policy.id, 'audit');
  await expect(
    repository.saveExecution({
      ...frozen,
      lease,
      forecast: { ...frozen.forecast, aboveProbability: 0.1 },
    }),
  ).rejects.toThrow('cannot be replaced');
  await expect(
    repository.saveExecution({
      ...frozen,
      lease,
      researchInputSnapshot: { ...frozen.researchInputSnapshot, capturedAt: clock },
    }),
  ).rejects.toThrow('cannot be replaced');
  await expect(client.execute('DELETE FROM advisor_execution_inputs')).rejects.toThrow(
    'append-only',
  );
});

test('execution archive failure rolls back both account and fill before an exact retry', async () => {
  await advance();
  const before = await repository.readState(policy.id);
  await client.execute(`CREATE TRIGGER fail_execution_inputs BEFORE INSERT ON advisor_execution_inputs
    BEGIN SELECT RAISE(ABORT, 'archive failed'); END`);
  clock += 2000;
  await expect(advance()).rejects.toThrow('archive failed');
  const failed = await repository.readState(policy.id);
  expect(failed.account).toEqual(before.account);
  expect(failed.events).toEqual([]);
  await client.execute('DROP TRIGGER fail_execution_inputs');
  await advance({ allowNewAdvice: false });
  expect((await repository.readState(policy.id)).events[0].kind).toBe('fill');
  expect(loadBook).toHaveBeenCalledTimes(2);
});

test('a failed current forecast produces unavailable evidence and does not reuse the old bargain', async () => {
  getForecast.mockImplementation((options) => {
    if (options) throw new Error('calculation failed');
    return capture();
  });
  await advance();
  const state = await repository.readState(policy.id);
  expect(state.advice[0]).toMatchObject({
    action: 'wait',
    forecastReconciliation: { recomputed: false, reason: 'current_input_snapshot_unavailable' },
  });
  expect(state.account.pendingIntents).toEqual([]);
});

test('failure of the original comparison capture still allows a valid current calculation', async () => {
  getForecast.mockImplementation((options) => {
    if (!options) throw new Error('original calculation failed');
    return capture(options);
  });
  await advance();
  const state = await repository.readState(policy.id);
  expect(state.advice[0]).toMatchObject({
    action: 'buy',
    forecastReconciliation: { recomputed: true, originalForecast: { available: false } },
  });
});

/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { TRADING_ADVISOR_POLICY } from '../utils/tradingAdvisor.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
const policy = TRADING_ADVISOR_POLICY;
let client;
let clock;
let probability;
let repository;
let service;
let loadBook;
let loadMarket;
const advance = () =>
  service.advance({
    market: { ...contract, status: 'active' },
    getForecast: () => forecastAt(clock, probability),
  });
beforeEach(() => {
  clock = START + 60000;
  probability = 0.85;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  loadBook = jest.fn(async () => bookAt(clock));
  loadMarket = jest.fn(async () => outcomeAt(clock));
  service = createTradingAdvisorService({
    repository,
    loadBook,
    loadMarket,
    now: () => clock,
    owner: 'service-one',
  });
});
afterEach(() => client.close());

test('reporting does not enroll an experiment or fetch prices', async () => {
  const report = await service.getReport();
  expect(report).toMatchObject({
    startedAt: null,
    simulated: true,
    latestAdvice: null,
    portfolio: { cash: 100 },
    collector: { status: 'not-started' },
  });
  expect(loadBook).not.toHaveBeenCalled();
  expect(loadMarket).not.toHaveBeenCalled();
  expect((await repository.readState(policy.id)).policy).toBeNull();
});

test('records advice, performs one delayed fill, holds, and compares completed settlement with holding', async () => {
  await advance();
  let report = await service.getReport();
  expect(report.latestAdvice).toMatchObject({ action: 'buy', executionStatus: 'pending' });
  expect(report.portfolio.cash).toBeLessThan(100);
  expect(report.latestAdvice.validUntil).toBe(clock + 15000);
  clock += 1000;
  await advance();
  expect(loadBook).toHaveBeenCalledTimes(1);
  clock += 1000;
  await advance();
  report = await service.getReport();
  expect(report.latestAdvice.executionStatus).toBe('filled');
  expect(report.portfolio.positions).toHaveLength(1);
  expect(loadBook).toHaveBeenCalledTimes(2);
  clock += 13000;
  await advance();
  expect((await service.getReport()).latestAdvice.action).toBe('hold');
  clock = contract.expiresAt + 1000;
  await advance();
  report = await service.getReport();
  expect(report.portfolio.positions).toHaveLength(0);
  expect(report.performance).toMatchObject({
    entryCount: 1,
    settledCount: 1,
    pairedPositionCount: 1,
    pairedAdvantage: 0,
  });
  expect(report.portfolio.cash).toBeCloseTo(100 + report.portfolio.realizedPnl, 7);
  expect(loadMarket).toHaveBeenCalledTimes(1);
});

test('a sell recommendation closes the recorded holdings and waits for official paired scoring', async () => {
  await advance();
  clock += 2000;
  await advance();
  clock += 13000;
  probability = 0.2;
  await advance();
  expect((await service.getReport()).latestAdvice.action).toBe('sell');
  clock += 2000;
  await advance();
  let report = await service.getReport();
  expect(report.portfolio.positions).toHaveLength(0);
  expect(report.performance).toMatchObject({
    exitCount: 1,
    pairedPositionCount: 0,
    pendingComparisonCount: 1,
  });
  clock = contract.expiresAt + 1000;
  loadMarket.mockResolvedValue(outcomeAt(clock, 'no'));
  await advance();
  report = await service.getReport();
  expect(report.performance.pairedPositionCount).toBe(1);
  expect(report.performance.pairedAdvantage).toBeGreaterThan(0);
});

test('a failed execution write retries the exact captured book under a new lease without another request', async () => {
  await advance();
  const save = repository.saveExecution;
  const spy = jest
    .spyOn(repository, 'saveExecution')
    .mockRejectedValueOnce(new Error('transient storage failure'));
  clock += 2000;
  await expect(advance()).rejects.toThrow('transient');
  const frozen = spy.mock.calls[0][0];
  expect(loadBook).toHaveBeenCalledTimes(2);
  spy.mockImplementation(save);
  clock += 1000;
  await advance();
  const retry = spy.mock.calls[1][0];
  expect(retry.book).toEqual(frozen.book);
  expect(retry.recordedAt).toBe(frozen.recordedAt);
  expect(retry.observationAttemptToken).toBe(frozen.observationAttemptToken);
  expect(retry.lease.token).not.toBe(frozen.lease.token);
  expect(loadBook).toHaveBeenCalledTimes(2);
  expect((await service.getReport()).performance.fillCount).toBe(1);
});

test('a failed execution request retries its frozen no-fill after a transient write failure and renewed lease', async () => {
  await advance();
  loadBook.mockRejectedValueOnce(new Error('execution request failed'));
  const save = repository.saveExecution;
  const spy = jest
    .spyOn(repository, 'saveExecution')
    .mockRejectedValueOnce(new Error('transient no-fill write failure'));
  clock += 2000;
  await expect(advance()).rejects.toThrow('transient no-fill');
  const frozen = spy.mock.calls[0][0];
  expect(frozen.book).toBeNull();
  expect(frozen.observationAttemptToken).toBe(frozen.lease.token);
  expect(loadBook).toHaveBeenCalledTimes(2);
  spy.mockImplementation(save);
  clock += 1000;
  await advance();
  const retry = spy.mock.calls[1][0];
  expect(retry.book).toBeNull();
  expect(retry.recordedAt).toBe(frozen.recordedAt);
  expect(retry.observationAttemptToken).toBe(frozen.observationAttemptToken);
  expect(retry.lease.token).not.toBe(frozen.lease.token);
  expect(loadBook).toHaveBeenCalledTimes(2);
  const report = await service.getReport();
  expect(report.performance).toMatchObject({ fillCount: 0, noFillCount: 1 });
  expect(report.portfolio).toMatchObject({ cash: 100, reservedCapital: 0, positions: [] });
  expect(report.latestAdvice.executionStatus).toBe('no-fill');
});

test('an unknown successful commit is retried idempotently without a second fill', async () => {
  await advance();
  const save = repository.saveExecution;
  jest
    .spyOn(repository, 'saveExecution')
    .mockImplementationOnce(async (input) => {
      await save(input);
      throw new Error('response lost after commit');
    })
    .mockImplementation(save);
  clock += 2000;
  await expect(advance()).rejects.toThrow('response lost');
  clock += 1000;
  await advance();
  expect((await service.getReport()).performance.fillCount).toBe(1);
  expect(loadBook).toHaveBeenCalledTimes(2);
});

test('the same serialized collector recovers from a failed lease release without a sixty-second stall', async () => {
  const release = repository.releaseLease;
  const releaseSpy = jest
    .spyOn(repository, 'releaseLease')
    .mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
  await expect(advance()).rejects.toThrow('database is locked');
  const previousLease = releaseSpy.mock.calls[0][0];
  expect(await repository.acquireLease(policy.id, 'different-process')).toBeNull();
  releaseSpy.mockImplementation(release);
  const attemptSpy = jest.spyOn(repository, 'claimExecutionAttempt');
  clock += policy.minimumFillDelayMs;
  await advance();
  const renewedLease = attemptSpy.mock.calls[0][0].lease;
  expect(renewedLease.owner).toBe(previousLease.owner);
  expect(renewedLease.token).not.toBe(previousLease.token);
  expect(clock).toBeLessThan(previousLease.expiresAt);
  expect((await service.getReport()).performance.fillCount).toBe(1);
  await expect(
    repository.writeHeartbeat(
      { policyId: policy.id, status: 'running', heartbeatAt: clock },
      previousLease,
    ),
  ).rejects.toMatchObject({ code: 'ADVISOR_LEASE_LOST' });
  expect(loadBook).toHaveBeenCalledTimes(2);
});

test('another collector cannot abandon an execution while its original request is still in progress', async () => {
  await advance();
  let resolveBook;
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  loadBook.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveBook = resolve;
        requestStarted();
      }),
  );
  clock += 2000;
  const executing = advance();
  await started;
  const second = createTradingAdvisorService({
    repository,
    loadBook,
    loadMarket,
    now: () => clock,
    owner: 'service-two',
  });
  await second.advance({ market: contract, getForecast: () => forecastAt(clock) });
  expect((await repository.readState(policy.id)).account.pendingIntents).toHaveLength(1);
  expect((await repository.readState(policy.id)).account.performance.noFillCount).toBe(0);
  resolveBook(bookAt(clock));
  await executing;
  expect((await service.getReport()).performance.fillCount).toBe(1);
});

test('restart after a durable request claim records an expired no-fill and never fetches a replacement', async () => {
  await advance();
  const state = await repository.readState(policy.id);
  clock += 2000;
  const abandoned = await repository.acquireLease(policy.id, 'abandoned-process');
  await repository.claimExecutionAttempt({
    adviceId: state.account.pendingIntents[0].id,
    requestedAt: clock,
    lease: abandoned,
  });
  clock += 61000;
  const restartedBook = jest.fn(async () => bookAt(clock));
  const restarted = createTradingAdvisorService({
    repository,
    loadBook: restartedBook,
    loadMarket,
    now: () => clock,
    owner: 'restarted-process',
  });
  await restarted.advance({ market: null, getForecast: () => forecastAt(clock) });
  expect(restartedBook).not.toHaveBeenCalled();
  expect((await restarted.getReport()).portfolio).toMatchObject({
    cash: 100,
    reservedCapital: 0,
    positions: [],
  });
  expect((await restarted.getReport()).performance.noFillCount).toBe(1);
});

test('unavailable books and missing causal model inputs produce saved wait observations', async () => {
  loadBook.mockRejectedValueOnce(new Error('upstream unavailable'));
  await advance();
  expect((await service.getReport()).latestAdvice.action).toBe('wait');
  clock += 15000;
  await service.advance({
    market: contract,
    getForecast: () => ({ ...forecastAt(clock), researchInputSnapshot: null }),
  });
  const report = await service.getReport();
  expect(report.latestAdvice.reason).toBe('forecast_unavailable_or_stale');
  expect(report.performance).toMatchObject({ waitCount: 2, entryCount: 0 });
});

test('unknown official outcomes keep positions open and throttle repeated settlement requests', async () => {
  await advance();
  clock += 2000;
  await advance();
  loadMarket.mockRejectedValue(new Error('market unavailable'));
  clock = contract.expiresAt + 1000;
  await advance();
  clock += 1000;
  await advance();
  expect(loadMarket).toHaveBeenCalledTimes(1);
  expect((await service.getReport()).portfolio.positions).toHaveLength(1);
  clock += 60000;
  await advance();
  expect(loadMarket).toHaveBeenCalledTimes(2);
  await service.stop();
  expect((await service.getReport()).collector.status).toBe('stopped');
});

test('entry archives retain full causal inputs while ordinary hold snapshots stay compact', async () => {
  await advance();
  const first = (await service.getReport()).latestAdvice;
  expect(
    (await repository.readAdvice(first.id, { includeInputs: true })).forecast.researchInputSnapshot,
  ).toEqual(forecastAt(clock).researchInputSnapshot);
  clock += 2000;
  await advance();
  clock += 13000;
  await advance();
  const latest = (await service.getReport()).latestAdvice;
  const saved = await repository.readAdvice(latest.id, { includeInputs: true });
  expect(saved.forecast.researchInputSnapshot).toBeUndefined();
  expect(saved.portfolio.positions).toHaveLength(1);
});

/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createAdvisorHistoryTrialRepository } from '@/services/research/tradingAdvisor/advisorHistoryTrials.repository';
import { createAdvisorHistoryTrialService } from '@/services/research/tradingAdvisor/advisorHistoryTrials.service';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { getTradingAdvice } from '../utils/tradingAdvisor.utils';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { START, contract, bookAt, forecastAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
const policy = createTradingAdvisorPolicy({ runId: 'history-service' });
const configuration = {
  enabled: true,
  model: 'mock-model',
  promptVersion: 'test-prompt-v1',
  minimumRequestIntervalMs: 30000,
};
let clock;
let client;
let repository;
let incumbentRepository;
const services = [];
const resolutions = [];

beforeEach(() => {
  clock = START - 1000;
  client = createClient({ url: 'file::memory:' });
  repository = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  incumbentRepository = createTradingAdvisorRepository({ client, now: () => clock });
});
afterEach(async () => {
  for (const resolve of resolutions.splice(0))
    resolve({ status: 'canceled', respondedAt: clock, inferenceCostUsd: 0 });
  await Promise.all(services.splice(0).map((service) => service.stop()));
  client.close();
});

function deferredProvider(enabled = true) {
  let resolve;
  const response = new Promise((complete) => (resolve = complete));
  resolutions.push(resolve);
  return {
    configuration: { ...configuration, enabled },
    invoke: jest.fn(() => response),
    resolve,
  };
}
function trialService(provider, storage = repository) {
  const service = createAdvisorHistoryTrialService({
    repository: storage,
    policy,
    provider,
    now: () => clock,
  });
  services.push(service);
  return service;
}
const observation = (extra = {}) => ({
  sourceId: `snapshot-${clock}`,
  contract,
  forecast: forecastAt(clock),
  book: bookAt(clock),
  observedAt: clock,
  ...extra,
});
const advance = (service) =>
  service.advance({ market: contract, getForecast: () => forecastAt(clock) });
function responseFor(provider, action = 'BUY_YES') {
  const evidence = provider.invoke.mock.calls[0][0].evidence;
  const option = evidence.options.find((row) => row.action === action);
  return {
    status: 'completed',
    respondedAt: clock,
    model: configuration.model,
    inferenceCostUsd: 0.003,
    output: {
      action,
      optionId: option.id,
      snapshotId: evidence.snapshotId,
      evidenceRefs: [evidence.points.at(-1).id, evidence.account.id],
      rationale: 'Current evidence supports the opportunity after costs.',
      thesis: 'Continue only while probability and executable value support the position.',
      invalidationConditions: ['Fresh evidence materially weakens the opportunity.'],
      reviewHorizon: '15s',
    },
  };
}

test('unresolved inference cannot block incumbent advances or retain its execution lease', async () => {
  const provider = deferredProvider();
  const historyTrials = trialService(provider);
  const service = createTradingAdvisorService({
    repository: incumbentRepository,
    historyTrials,
    policy,
    now: () => clock,
    loadBook: async () => bookAt(clock),
  });
  await advance(service);
  clock = START + 60000;
  await advance(service);
  expect(provider.invoke).toHaveBeenCalledTimes(1);
  const entry = (await service.getReport()).latestAdvice;
  expect(entry.action).toBe('buy');
  const lease = await incumbentRepository.acquireLease(policy.id, 'independent-observer');
  expect(lease).not.toBeNull();
  await incumbentRepository.releaseLease(lease);
  clock += policy.minimumFillDelayMs;
  await advance(service);
  const report = await service.getReport();
  expect(report.latestAdvice.executionStatus).toBe('filled');
  expect(report.portfolio.positions).toHaveLength(1);
  expect(provider.invoke).toHaveBeenCalledTimes(1);
  const saved = await incumbentRepository.readAdvice(entry.id, { includeInputs: true });
  const replay = getTradingAdvice({
    contract: saved.contract,
    forecast: saved.forecast,
    book: saved.book,
    portfolio: saved.portfolio,
    now: saved.evaluatedAt,
    policy: saved.policy,
  });
  for (const [key, value] of Object.entries(replay)) expect(saved[key]).toEqual(value);
});

test('disabled provider never invokes inference while the incumbent and history rules continue', async () => {
  const provider = deferredProvider(false);
  const service = trialService(provider);
  const registered = await service.start();
  clock = START + 60000;
  await service.observe(observation());
  clock += 2000;
  await service.observe(observation({ forecast: undefined }));
  const state = await repository.readState(registered.id);
  expect(state.strategies.incumbent.account.positions).toHaveLength(1);
  expect(state.strategies['history-rules'].history).toHaveLength(1);
  expect(state.strategies['language-model'].pendingRequest).toBeNull();
  expect(provider.invoke).not.toHaveBeenCalled();
  expect((await service.getReport()).provider.status).toBe('disabled');
});

test('an independent AI order receives its delayed fill while the incumbent only holds', async () => {
  const provider = deferredProvider();
  const historyTrials = trialService(provider);
  const loadBook = jest.fn(async () => bookAt(clock));
  const service = createTradingAdvisorService({
    repository: incumbentRepository,
    historyTrials,
    policy,
    now: () => clock,
    loadBook,
  });
  const registration = await historyTrials.start();
  await advance(service);
  clock = START + 60000;
  await advance(service);
  clock += 2000;
  await advance(service);
  clock += 2000;
  provider.resolve(responseFor(provider));
  await historyTrials.flush();
  clock = START + 75000;
  await advance(service);
  const holding = await service.getReport();
  expect(holding.latestAdvice.action).toBe('hold');
  let state = await repository.readState(registration.id);
  expect(state.strategies['language-model'].account.pendingIntents).toHaveLength(1);
  expect(state.strategies['language-model'].account.positions).toHaveLength(0);
  const bookReads = loadBook.mock.calls.length;
  clock += policy.minimumFillDelayMs;
  await advance(service);
  state = await repository.readState(registration.id);
  expect(state.strategies['language-model'].account.positions).toHaveLength(1);
  expect(state.strategies['language-model'].account.pendingIntents).toHaveLength(0);
  expect(loadBook).toHaveBeenCalledTimes(bookReads + 1);
  expect((await service.getReport()).latestAdvice.id).toBe(holding.latestAdvice.id);
  expect((await service.getReport()).portfolio.cash).toBe(holding.portfolio.cash);
  expect(provider.invoke).toHaveBeenCalledTimes(1);
});

test('a shadow registration failure does not suppress a valid incumbent recommendation', async () => {
  const failingRepository = {
    ...repository,
    ensureTrial: jest.fn(async () => {
      throw new Error('shadow storage temporarily unavailable');
    }),
  };
  const provider = deferredProvider();
  const historyTrials = trialService(provider, failingRepository);
  const service = createTradingAdvisorService({
    repository: incumbentRepository,
    historyTrials,
    policy,
    now: () => clock,
    loadBook: async () => bookAt(clock),
  });
  clock = START + 60000;
  await advance(service);
  expect((await service.getReport()).latestAdvice.action).toBe('buy');
  expect(provider.invoke).not.toHaveBeenCalled();
  const lease = await incumbentRepository.acquireLease(policy.id, 'after-shadow-failure');
  expect(lease).not.toBeNull();
  await incumbentRepository.releaseLease(lease);
});

test('a recorded proposal survives restart and buys only after a new acceptance and fill delay', async () => {
  const provider = deferredProvider();
  const service = trialService(provider);
  const registered = await service.start();
  clock = START + 60000;
  await service.observe(observation());
  clock += 4000;
  provider.resolve(responseFor(provider));
  await service.flush();
  const proposed = await repository.readState(registered.id);
  expect(proposed.strategies['language-model'].pendingRequest.result.status).toBe('completed');
  expect(proposed.strategies['language-model'].account.cash).toBe(100);
  await service.stop();
  const restartedRepository = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  const restartedProvider = deferredProvider();
  const restarted = trialService(restartedProvider, restartedRepository);
  expect(await restarted.start()).toEqual(proposed);
  clock += 1000;
  await restarted.observe(observation());
  let state = await restartedRepository.readState(registered.id);
  let account = state.strategies['language-model'].account;
  expect(account.pendingIntents).toHaveLength(1);
  expect(account.pendingIntents[0]).toMatchObject({
    evaluatedAt: clock,
    candidatePolicyVersion: 'history-llm-v1',
  });
  expect(account.positions).toHaveLength(0);
  expect(restartedProvider.invoke).not.toHaveBeenCalled();
  clock += 1000;
  await restarted.observe(observation({ forecast: undefined }));
  expect(
    (await restartedRepository.readState(registered.id)).strategies['language-model'].account
      .positions,
  ).toHaveLength(0);
  clock += 1000;
  await restarted.observe(observation({ forecast: undefined }));
  state = await restartedRepository.readState(registered.id);
  account = state.strategies['language-model'].account;
  expect(account.positions).toHaveLength(1);
  expect(account.pendingIntents).toHaveLength(0);
  expect(account.cash + account.positions[0].costBasis).toBeCloseTo(100, 7);
  const secondRestart = trialService(deferredProvider(), restartedRepository);
  expect((await secondRestart.start()).strategies['language-model'].account).toEqual(account);
  expect(
    (await secondRestart.getReport()).strategies.find((row) => row.id === 'language-model')
      .inferenceCost,
  ).toBe(0.003);
});

test('an expired request falls back at observation time and a late response cannot alter its account', async () => {
  const provider = deferredProvider();
  const service = trialService(provider);
  const registered = await service.start();
  clock = START + 60000;
  await service.observe(observation());
  const originalRequest = provider.invoke.mock.calls[0][0];
  clock = originalRequest.evidence.expiresAt;
  await service.observe(observation());
  const before = await repository.readState(registered.id);
  const strategy = before.strategies['language-model'];
  expect(strategy.latestDecision).toMatchObject({
    status: 'fallback',
    fallbackReason: 'response_expired',
    assessedAt: clock,
  });
  expect(strategy.account.pendingIntents[0].evaluatedAt).toBe(clock);
  clock += 1000;
  provider.resolve(responseFor(provider));
  await service.flush();
  const after = await repository.readState(registered.id);
  expect(after.strategies['language-model'].account).toEqual(strategy.account);
  expect(after.strategies['language-model'].latestDecision).toMatchObject({
    status: 'proposed',
    reason: 'superseded_response',
    assessedAt: clock,
  });
  expect(after.strategies['language-model'].inferenceCost).toBe(0.003);
});

test('a completed response whose evidence expired is vetoed without backdating the fallback', async () => {
  const provider = deferredProvider();
  const service = trialService(provider);
  const registered = await service.start();
  clock = START + 60000;
  await service.observe(observation());
  const request = provider.invoke.mock.calls[0][0];
  clock = request.evidence.expiresAt + 1;
  provider.resolve(responseFor(provider));
  await service.flush();
  clock += 1000;
  await service.observe(observation());
  const state = await repository.readState(registered.id);
  const strategy = state.strategies['language-model'];
  expect(strategy.latestDecision).toMatchObject({
    status: 'fallback',
    fallbackReason: 'expired_or_noncausal_response',
    assessedAt: clock,
  });
  expect(strategy.account.pendingIntents[0].evaluatedAt).toBe(clock);
  expect(strategy.plan).toBeNull();
});

/** @jest-environment node */
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createConfiguredTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { createTradingPolicyTrialRepository } from '@/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createTradingPolicyTrialService } from '@/services/research/tradingAdvisor/tradingPolicyTrials.service';
import { createAdvisorHistoryTrialRepository } from '@/services/research/tradingAdvisor/advisorHistoryTrials.repository';
import {
  getAdvisorLanguageModelConfiguration,
  getAdvisorLanguageModelPublicConfiguration,
} from '@/services/research/tradingAdvisor/advisorLanguageModel.service';
import {
  createAdvisorResearchPolicy,
  createTradingAdvisorPolicy,
  getAdvisorEntryRisk,
  isAdvisorV2Policy,
} from '../utils/advisorPolicy.utils';
import { getTradingAdvice } from '../utils/tradingAdvisor.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/services/research/tradingAdvisor/advisorLanguageModel.service', () => {
  const actual = jest.requireActual(
    '@/services/research/tradingAdvisor/advisorLanguageModel.service',
  );
  return {
    ...actual,
    getAdvisorLanguageModelConfiguration: () => actual.getAdvisorLanguageModelConfiguration({}),
  };
});

let client;
let clock;
let repository;
let trialRepository;
let historyTrialRepository;
let configuration;
let researchPolicy;
let service;
let loadBook;
let loadMarket;

const makeService = () =>
  createConfiguredTradingAdvisorService({
    repository,
    trialRepository,
    historyTrialRepository,
    loadBook,
    loadMarket,
    now: () => clock,
  });
const advance = () =>
  service.advance({
    market: { ...contract, status: 'active' },
    getForecast: () => forecastAt(clock),
  });

beforeEach(async () => {
  clock = START - 1000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  trialRepository = createTradingPolicyTrialRepository({ client, now: () => clock });
  historyTrialRepository = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  configuration = await repository.configure({
    allocation: 100,
    riskLevel: 'balanced',
    expectedRevision: 0,
  });
  researchPolicy = createAdvisorResearchPolicy(configuration.policy);
  loadBook = jest.fn(async () => bookAt(clock));
  loadMarket = jest.fn(async () => outcomeAt(clock));
  service = makeService();
});

afterEach(async () => {
  await service.stop();
  client.close();
});

async function seedOriginalLosses() {
  const state = await repository.readState(configuration.policy.id);
  // Reproduce the already-settled account snapshot without fabricating new trial trades.
  const account = {
    ...state.account,
    cash: 85.079,
    realizedPnl: -14.921,
    dailyRealizedPnl: -14.921,
    realizedDay: new Date(clock).toISOString().slice(0, 10),
    performance: {
      ...state.account.performance,
      grossLosses: 14.921,
      maxRealizedDrawdown: 14.921,
      lossCount: 3,
    },
  };
  const payload = JSON.stringify(account);
  await client.execute({
    sql: 'UPDATE advisor_accounts SET payload = ?, content_hash = ? WHERE policy_id = ?',
    args: [payload, createHash('sha256').update(payload).digest('hex'), configuration.policy.id],
  });
  return account;
}

test('a research version changes only entry size and keeps stable, distinct risk identity', () => {
  expect(researchPolicy).toEqual({
    ...configuration.policy,
    id: researchPolicy.id,
    maxEntryContracts: 1,
  });
  expect(researchPolicy.id).not.toBe(configuration.policy.id);
  expect(researchPolicy.maxContracts).toBe(100);
  expect(researchPolicy.maxDrawdown).toBe(15);
  expect(createAdvisorResearchPolicy(configuration.policy)).toEqual(researchPolicy);
  expect(createAdvisorResearchPolicy(researchPolicy)).toEqual(researchPolicy);
  expect(configuration.policy.maxEntryContracts).toBeUndefined();
  expect(isAdvisorV2Policy(researchPolicy)).toBe(true);
  expect(isAdvisorV2Policy({ ...researchPolicy, maxEntryContracts: 2 })).toBe(false);
  expect(isAdvisorV2Policy({ ...configuration.policy, maxEntryContracts: 1 })).toBe(false);
  const longestOriginal = createTradingAdvisorPolicy({ runId: 'a'.repeat(80) });
  expect(isAdvisorV2Policy(createAdvisorResearchPolicy(longestOriginal))).toBe(true);
});

test('reading the report preserves original losses and never enrolls or funds a research account', async () => {
  const account = await seedOriginalLosses();
  const before = await repository.readConfiguration();
  const report = await service.getReport();
  expect(report.policy).toEqual(configuration.policy);
  expect(report.portfolio).toMatchObject({ cash: 85.079, realizedPnl: -14.921 });
  expect(report.trials.phase).toBe('not-started');
  expect(report.historyTrials.status).toBe('not-started');
  expect(await trialRepository.readState(researchPolicy.id)).toBeNull();
  expect((await client.execute('SELECT id FROM advisor_history_trials')).rows).toHaveLength(0);
  expect((await repository.readState(configuration.policy.id)).account).toEqual(account);
  expect(await repository.readConfiguration()).toEqual(before);
  expect(loadBook).not.toHaveBeenCalled();
  expect(loadMarket).not.toHaveBeenCalled();
});

test('independent trials buy one contract while the original account preserves its $85 floor', async () => {
  await seedOriginalLosses();
  await advance();
  clock = START + 60000;
  await advance();
  const report = await service.getReport();
  expect(report.latestAdvice.action).toBe('wait');
  expect(report.latestAdvice.reason).toBe('insufficient_loss_capacity');
  expect(
    getAdvisorEntryRisk({
      portfolio: report.latestAdvice.portfolio,
      policy: configuration.policy,
      now: clock,
    }).budget,
  ).toBeCloseTo(0.079, 8);
  expect(report.portfolio).toMatchObject({
    cash: 85.079,
    realizedPnl: -14.921,
    pendingIntents: [],
    positions: [],
  });
  expect(report.risk.history.peakEquity - report.policy.maxDrawdown).toBe(85);
  const trial = await trialRepository.readState(researchPolicy.id);
  const history = await historyTrialRepository.readState(report.historyTrials.id);
  for (const strategy of [...Object.values(trial.strategies), history.strategies.incumbent]) {
    expect(strategy.account.pendingIntents).toHaveLength(1);
    expect(strategy.account.pendingIntents[0]).toMatchObject({
      action: 'buy',
      quantity: 1,
      policyId: researchPolicy.id,
    });
  }
  expect(loadBook).toHaveBeenCalledTimes(1);
  clock += 2000;
  await advance();
  const filledTrial = await trialRepository.readState(researchPolicy.id);
  const filledHistory = await historyTrialRepository.readState(report.historyTrials.id);
  for (const strategy of [
    ...Object.values(filledTrial.strategies),
    filledHistory.strategies.incumbent,
  ]) {
    expect(strategy.account.pendingIntents).toHaveLength(0);
    expect(strategy.account.positions).toHaveLength(1);
    expect(strategy.account.positions[0].quantity).toBe(1);
    expect(strategy.account.cash).toBeGreaterThan(99);
  }
  const filledReport = await service.getReport();
  expect(filledReport.portfolio).toMatchObject({ cash: 85.079, realizedPnl: -14.921 });
  expect(filledReport.policy).toEqual(configuration.policy);
  expect(filledReport.configuration.revision).toBe(configuration.revision);
  expect(filledReport.trials.policyId).toBe(researchPolicy.id);
  expect(filledReport.historyTrials.policyId).toBe(researchPolicy.id);
  expect(loadBook).toHaveBeenCalledTimes(2);

  // The history rule waits for three supporting observations before committing its own capital.
  clock = START + 75000;
  await advance();
  clock = START + 90000;
  await advance();
  const rulesIntent = (await historyTrialRepository.readState(report.historyTrials.id)).strategies[
    'history-rules'
  ].account.pendingIntents;
  expect(rulesIntent).toHaveLength(1);
  expect(rulesIntent[0].quantity).toBe(1);
  clock += 2000;
  await advance();
  const rulesAccount = (await historyTrialRepository.readState(report.historyTrials.id)).strategies[
    'history-rules'
  ].account;
  expect(rulesAccount.pendingIntents).toHaveLength(0);
  expect(rulesAccount.positions[0].quantity).toBe(1);
  expect((await service.getReport()).portfolio.cash).toBe(85.079);
});

test('restart reuses funded trial accounts, keeps their losses, and leaves previous experiments intact', async () => {
  const oldTrial = await trialRepository.ensureTrial(configuration.policy, clock);
  const oldHistory = await historyTrialRepository.ensureTrial(
    configuration.policy,
    getAdvisorLanguageModelPublicConfiguration(getAdvisorLanguageModelConfiguration()),
    clock,
  );
  await seedOriginalLosses();
  await advance();
  clock = START + 60000;
  await advance();
  const decided = await service.getReport();
  clock += 2000;
  await advance();
  clock = contract.expiresAt;
  await service.observeOutcome(outcomeAt(clock, 'no'));
  const trialBefore = await trialRepository.readState(researchPolicy.id);
  const historyBefore = await historyTrialRepository.readState(decided.historyTrials.id);
  expect(trialBefore.strategies.standard.account.realizedPnl).toBeLessThan(0);
  expect(historyBefore.strategies.incumbent.account.realizedPnl).toBeLessThan(0);
  await service.stop();
  service = makeService();
  clock += 1000;
  await advance();
  const report = await service.getReport();
  expect(report.trials.policyId).toBe(researchPolicy.id);
  expect(report.trials.registeredAt).toBe(START - 1000);
  expect(report.historyTrials.id).toBe(decided.historyTrials.id);
  expect(report.historyTrials.registeredAt).toBe(START - 1000);
  expect(await trialRepository.readState(researchPolicy.id)).toEqual(trialBefore);
  expect(await historyTrialRepository.readState(decided.historyTrials.id)).toEqual(historyBefore);
  expect(await trialRepository.readState(configuration.policy.id)).toEqual(oldTrial);
  expect(await historyTrialRepository.readState(oldHistory.id)).toEqual(oldHistory);
  expect(report.trials.previousExperiments.map((trial) => trial.policyId)).toContain(
    configuration.policy.id,
  );
  expect(report.historyTrials.previousExperiments.map((trial) => trial.id)).toContain(
    oldHistory.id,
  );
  expect(report.portfolio).toMatchObject({ cash: 85.079, realizedPnl: -14.921 });
  expect(report.trials.strategies.map((strategy) => strategy.accountId)).toHaveLength(4);
  expect(new Set(report.historyTrials.strategies.map((strategy) => strategy.accountId)).size).toBe(
    3,
  );
});

test('a restarted collector settles old trial holdings with retries before new sizing begins', async () => {
  const oldHistory = await historyTrialRepository.ensureTrial(
    configuration.policy,
    getAdvisorLanguageModelPublicConfiguration(getAdvisorLanguageModelConfiguration()),
    clock,
  );
  const previousTrials = createTradingPolicyTrialService({
    repository: trialRepository,
    now: () => clock,
  });
  await previousTrials.ensureTrial(configuration.policy, clock);
  clock = START + 60000;
  await previousTrials.observe({
    contract,
    forecast: forecastAt(clock),
    book: bookAt(clock),
    observedAt: clock,
  });
  await historyTrialRepository.record(oldHistory.id, {
    id: 'previous-history-entry',
    kind: 'observation',
    contract,
    forecast: forecastAt(clock),
    book: bookAt(clock),
    observedAt: clock,
  });
  const pending = await trialRepository.readState(configuration.policy.id);
  expect(pending.strategies.standard.account.pendingIntents[0].quantity).toBeGreaterThan(1);
  const savedQuantity = pending.strategies.standard.account.pendingIntents[0].quantity;
  await seedOriginalLosses();
  clock += 2000;
  await advance();
  const draining = await service.getReport();
  expect(draining.trials.policyId).toBe(configuration.policy.id);
  expect(await trialRepository.readState(researchPolicy.id)).toBeNull();
  const filled = await trialRepository.readState(configuration.policy.id);
  expect(filled.strategies.standard.account.pendingIntents).toHaveLength(0);
  expect(filled.strategies.standard.account.positions[0].quantity).toBe(savedQuantity);
  expect(
    (await historyTrialRepository.readState(oldHistory.id)).strategies.incumbent.account
      .positions[0].quantity,
  ).toBe(savedQuantity);
  expect(draining.portfolio.cash).toBe(85.079);
  await service.stop();
  service = makeService();
  loadMarket.mockImplementationOnce(async () => null);
  loadMarket.mockImplementation(async () => outcomeAt(clock, 'no'));
  clock = contract.expiresAt;
  await advance();
  expect(loadMarket).toHaveBeenCalledTimes(1);
  expect(loadMarket).toHaveBeenCalledWith(contract.ticker);
  expect(
    (await trialRepository.readState(configuration.policy.id)).strategies.standard.account
      .positions,
  ).toHaveLength(1);
  clock += 59999;
  await advance();
  expect(loadMarket).toHaveBeenCalledTimes(1);
  clock += 10001;
  await advance();
  expect(loadMarket).toHaveBeenCalledTimes(2);
  const archived = await trialRepository.readState(configuration.policy.id);
  expect(archived.strategies.standard.account.positions).toHaveLength(0);
  expect(archived.strategies.standard.account.realizedPnl).toBeLessThan(-1);
  const archivedHistory = await historyTrialRepository.readState(oldHistory.id);
  expect(archivedHistory.strategies.incumbent.account.positions).toHaveLength(0);
  expect(archivedHistory.strategies.incumbent.account.realizedPnl).toBeLessThan(-1);
  clock += 1000;
  await advance();
  const report = await service.getReport();
  expect(report.trials.policyId).toBe(researchPolicy.id);
  expect(report.trials.maxEntryContracts).toBe(1);
  expect(report.trials.registeredAt).toBe(clock);
  expect(report.portfolio).toMatchObject({ cash: 85.079, realizedPnl: -14.921 });
  expect(await trialRepository.readState(configuration.policy.id)).toEqual(archived);
  expect(await historyTrialRepository.readState(oldHistory.id)).toEqual(archivedHistory);
  const priorReport = report.trials.previousExperiments.find(
    (trial) => trial.policyId === configuration.policy.id,
  );
  expect(priorReport.strategies.find((strategy) => strategy.id === 'standard').realizedPnl).toBe(
    archived.strategies.standard.account.realizedPnl,
  );
  expect(report.trials.strategies.find((strategy) => strategy.id === 'standard').realizedPnl).toBe(
    0,
  );
});

test('the original account retains its previously activated strategy with reproducible archived advice', async () => {
  await trialRepository.ensureTrial(configuration.policy, clock);
  const transition = { at: clock, kind: 'activated', strategyId: 'early-exit' };
  const payload = JSON.stringify(transition);
  await client.execute({
    sql: 'INSERT INTO advisor_profit_transitions VALUES (?, ?, ?, ?, ?)',
    args: [
      configuration.policy.id,
      1,
      clock,
      payload,
      createHash('sha256').update(payload).digest('hex'),
    ],
  });
  await advance();
  clock = START + 60000;
  await advance();
  const report = await service.getReport();
  expect(report.latestAdvice.policy).toMatchObject({
    id: configuration.policy.id,
    strategyId: 'early-exit',
    minimumExitAdvantage: 0.005,
  });
  expect(report.latestAdvice.action).toBe('buy');
  expect(report.latestAdvice.quantity).toBeGreaterThan(1);
  expect(report.trials.policyId).toBe(researchPolicy.id);
  expect(report.trials.activeStrategyId).toBe('standard');
  const saved = await repository.readAdvice(report.latestAdvice.id, { includeInputs: true });
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

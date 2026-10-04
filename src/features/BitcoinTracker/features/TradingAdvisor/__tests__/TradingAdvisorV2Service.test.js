/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import {
  createConfiguredTradingAdvisorService,
  createTradingAdvisorService,
} from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { createTradingPolicyTrialRepository } from '@/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { getTradingAdvice, TRADING_ADVISOR_POLICY } from '../utils/tradingAdvisor.utils';
import { START, bookAt, contract, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
let client;
let clock;
let repository;
let trialRepository;
let service;
let configuration;
let probability;
let loadBook;
let loadMarket;
const makeService = () =>
  createConfiguredTradingAdvisorService({
    repository,
    trialRepository,
    loadBook,
    loadMarket,
    now: () => clock,
  });
const advance = (market = contract) =>
  service.advance({
    market: { ...market, status: 'active' },
    getForecast: () => forecastAt(clock, probability),
  });

beforeEach(async () => {
  clock = START - 1000;
  probability = 0.85;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  trialRepository = createTradingPolicyTrialRepository({ client, now: () => clock });
  loadBook = jest.fn(async () => bookAt(clock));
  loadMarket = jest.fn(async () => outcomeAt(clock));
  service = makeService();
});
afterEach(() => client.close());

async function configure() {
  configuration = await repository.configure({
    allocation: 50,
    riskLevel: 'balanced',
    expectedRevision: 0,
  });
  await advance(); // Register before the next event starts, without reading a book.
  clock = START + 60000;
}

test('configured v2 advice persists the exact risk portfolio and is reproducible without fetching', async () => {
  await configure();
  expect(loadBook).not.toHaveBeenCalled();
  await advance();
  const report = await service.getReport();
  expect(report.configuration.revision).toBe(1);
  expect(report.policy.initialBankroll).toBe(50);
  expect(report.latestAdvice.action).toBe('buy');
  expect(report.trials.enrolledContracts).toBe(1);
  const saved = await repository.readAdvice(report.latestAdvice.id, { includeInputs: true });
  expect(saved.portfolio.valuation).toMatchObject({ complete: true, executableEquity: 50 });
  expect(saved.portfolio.equityDay).toBe('2026-10-03');
  const replay = getTradingAdvice({
    contract: saved.contract,
    forecast: saved.forecast,
    book: saved.book,
    portfolio: saved.portfolio,
    now: saved.evaluatedAt,
    policy: saved.policy,
  });
  for (const [key, value] of Object.entries(replay)) expect(saved[key]).toEqual(value);
  expect(loadBook).toHaveBeenCalledTimes(1);
  expect(loadMarket).not.toHaveBeenCalled();
});

test('a partial shared execution releases cash once and keeps the main and shadow positions causal', async () => {
  await configure();
  await advance();
  const intent = (await service.getReport()).latestAdvice;
  expect(intent.quantity).toBeGreaterThan(1);
  clock += 2000;
  loadBook.mockImplementation(async () => ({
    ...bookAt(clock),
    yesAsks: [{ price: 0.5, quantity: 1 }],
  }));
  await advance();
  const report = await service.getReport();
  expect(report.portfolio.pendingIntents).toHaveLength(0);
  expect(report.portfolio.positions[0].quantity).toBe(1);
  expect(report.portfolio.cash + report.portfolio.positions[0].costBasis).toBeCloseTo(50, 7);
  const trial = await trialRepository.readState(configuration.policy.id);
  expect(trial.strategies.standard.account.positions[0].quantity).toBe(1);
  expect(trial.strategies.standard.account.cash).toBeCloseTo(report.portfolio.cash, 7);
  expect(loadBook).toHaveBeenCalledTimes(2);
  const cash = report.portfolio.cash;
  await advance();
  expect((await service.getReport()).portfolio.cash).toBe(cash);
  expect(loadBook).toHaveBeenCalledTimes(2);
  clock = contract.expiresAt;
  await advance();
  const settled = await service.getReport();
  expect(settled.portfolio.positions).toHaveLength(0);
  expect(settled.trials.resolvedContracts).toBe(1);
  expect(settled.portfolio.cash).toBeCloseTo(cash + 1, 7);
  expect(loadMarket).toHaveBeenCalledTimes(1);
});

test('expired delayed execution releases main and shadow reservations without retrying a favorable book', async () => {
  await configure();
  await advance();
  clock += 16000;
  probability = null;
  loadBook.mockImplementation(async () => null);
  await advance();
  const report = await service.getReport();
  expect(report.portfolio.pendingIntents).toHaveLength(0);
  expect(report.portfolio.cash).toBe(50);
  expect(report.portfolio.positions).toHaveLength(0);
  const trial = await trialRepository.readState(configuration.policy.id);
  expect(trial.strategies.standard.account.pendingIntents).toHaveLength(0);
  expect(trial.strategies.standard.account.cash).toBe(50);
  expect(
    report.recentActivity.some(
      (row) => row.kind === 'no-fill' && row.reason === 'execution_window_expired',
    ),
  ).toBe(true);
});

test('general collector settlements score zero-trade contracts without asking the exchange again', async () => {
  await configure();
  probability = null;
  await advance();
  expect((await service.getReport()).latestAdvice.action).toBe('wait');
  clock = contract.expiresAt;
  await service.observeOutcome(outcomeAt(clock));
  const report = await service.getReport();
  expect(report.trials.resolvedContracts).toBe(1);
  expect(report.trials.candidates[0].baselineProfit).toBe(0);
  expect(loadMarket).not.toHaveBeenCalled();
});

test('a restarted collector accepts official outcomes before its first new advance', async () => {
  await configure();
  probability = null;
  await advance();
  await service.stop();
  service = makeService();
  clock = contract.expiresAt;
  await service.observeOutcome(outcomeAt(clock));
  const report = await service.getReport();
  expect(report.trials.resolvedContracts).toBe(1);
  expect(report.trials.registeredAt).toBe(START - 1000);
  expect(loadBook).toHaveBeenCalledTimes(1);
  expect(loadMarket).not.toHaveBeenCalled();
});

test('a strategy activation changes only future decisions and keeps cash, risk and account identity', async () => {
  await configure();
  await advance();
  clock += 2000;
  await advance();
  const before = await repository.readState(configuration.policy.id);
  const cash = before.account.cash;
  const originalAdvice = await repository.readAdvice(before.advice[0].id);
  clock += 13000;
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
  const after = await repository.readState(configuration.policy.id);
  const selectedAdvice = await repository.readAdvice(after.advice[0].id);
  expect(selectedAdvice.policy.strategyId).toBe('early-exit');
  expect(selectedAdvice.policy.minimumExitAdvantage).toBe(0.005);
  expect(selectedAdvice.policy.maxDailyLoss).toBe(configuration.policy.maxDailyLoss);
  expect(selectedAdvice.policy.id).toBe(configuration.policy.id);
  expect(after.account.cash).toBe(cash);
  expect(after.account.positions).toEqual(before.account.positions);
  expect((await repository.readAdvice(originalAdvice.id)).policy.strategyId).toBe('standard');
});

test('setup refuses a running collector and open holdings rather than reallocating reserved cash', async () => {
  await configure();
  await advance();
  await expect(
    repository.configure({ allocation: 25, riskLevel: 'balanced', expectedRevision: 1 }),
  ).rejects.toThrow('Stop the collector');
  await service.stop();
  await expect(
    repository.configure({ allocation: 25, riskLevel: 'balanced', expectedRevision: 1 }),
  ).rejects.toThrow('open positions');
  expect((await repository.readConfiguration()).revision).toBe(1);
});

test('reconfiguring the automatic legacy successor carries its losses and retains the v2 drawdown stop', async () => {
  clock = START + 60000;
  await advance();
  const previousConfiguration = await repository.readConfiguration();
  expect(previousConfiguration.policy.id).toMatch(/^kalshi-advisor-v3-/);
  expect(previousConfiguration.policy.dailyLossLimitEnabled).toBe(false);
  clock += 2000;
  await advance();
  loadMarket.mockImplementation(async () => outcomeAt(clock, 'no'));
  clock = contract.expiresAt;
  await advance();
  await service.stop();
  const legacy = await repository.readState(previousConfiguration.policy.id);
  expect(legacy.account.realizedPnl).toBeLessThan(-5);
  configuration = await repository.configure({
    allocation: 50,
    riskLevel: 'balanced',
    expectedRevision: previousConfiguration.revision,
  });
  const converted = await repository.readState(configuration.policy.id);
  expect(converted.account.realizedPnl).toBe(legacy.account.realizedPnl);
  expect(converted.account.dailyRealizedPnl).toBe(legacy.account.dailyRealizedPnl);
  expect(converted.account.cash).toBeCloseTo(legacy.account.cash - 50, 7);
  expect(converted.risk.history.peakEquity).toBe(50);
  expect(await repository.acquireLease(previousConfiguration.policy.id, 'old-writer')).toBeNull();
  expect((await repository.readState(previousConfiguration.policy.id)).account).toEqual(
    legacy.account,
  );
  clock += 1000;
  const next = {
    ...contract,
    ticker: 'KXBTC15M-NEXT',
    eventTicker: 'KXBTC15M-NEXT',
    startsAt: contract.expiresAt,
    expiresAt: contract.expiresAt + 900000,
  };
  loadBook.mockImplementation(async () => ({ ...bookAt(clock), ticker: next.ticker }));
  await advance(next);
  const report = await service.getReport();
  expect(report.latestAdvice.action).toBe('wait');
  expect(report.latestAdvice.reason).toBe('equity_drawdown_limit');
  expect(report.portfolio.realizedPnl).toBe(legacy.account.realizedPnl);
  expect(report.portfolio.cash).toBe(converted.account.cash);
});

test('the first configured advance retires the legacy daily cutoff without resetting cash, losses or archived evidence', async () => {
  const legacyService = createTradingAdvisorService({
    repository,
    policy: TRADING_ADVISOR_POLICY,
    loadBook,
    loadMarket,
    now: () => clock,
  });
  const advanceLegacy = () =>
    legacyService.advance({
      market: { ...contract, status: 'active' },
      getForecast: () => forecastAt(clock, probability),
    });
  clock = START + 60000;
  await advanceLegacy();
  const originalAdvice = (await legacyService.getReport()).latestAdvice;
  const archivedAdvice = await repository.readAdvice(originalAdvice.id, { includeInputs: true });
  clock += 2000;
  await advanceLegacy();
  loadMarket.mockImplementation(async () => outcomeAt(clock, 'no'));
  clock = contract.expiresAt;
  await advanceLegacy();
  await legacyService.stop();
  const before = await repository.readState(TRADING_ADVISOR_POLICY.id);
  expect(before.account.dailyRealizedPnl).toBeLessThan(-TRADING_ADVISOR_POLICY.maxDailyLoss);
  expect(before.account.positions).toHaveLength(0);
  expect(before.account.pendingIntents).toHaveLength(0);
  expect(before.account.pendingComparisons).toHaveLength(0);
  expect((await repository.readConfiguration()).revision).toBe(0);
  const bookCalls = loadBook.mock.calls.length;

  // This first configured advance sees a closed event, so the rollover itself has no new
  // advice, trade or book request that could mask a changed balance or risk history.
  await advance();
  const migrated = await repository.readConfiguration();
  expect(migrated).toMatchObject({
    revision: 1,
    previousPolicyId: TRADING_ADVISOR_POLICY.id,
    reason: 'daily_loss_limit_removed',
    policy: { dailyLossLimitEnabled: false, initialBankroll: 100 },
  });
  expect(migrated.policy.id).toMatch(/^kalshi-advisor-v3-/);
  const after = await repository.readState(migrated.policy.id);
  expect(after.account).toEqual({ ...before.account, version: before.account.version + 1 });
  expect(after.risk.history).toEqual(before.risk.history);
  expect(after.risk.valuation).toBeNull();
  expect(loadBook).toHaveBeenCalledTimes(bookCalls);
  expect(await repository.acquireLease(TRADING_ADVISOR_POLICY.id, 'retired-writer')).toBeNull();
  expect((await repository.readState(TRADING_ADVISOR_POLICY.id)).account).toEqual(before.account);
  expect(await repository.readAdvice(originalAdvice.id, { includeInputs: true })).toEqual(
    archivedAdvice,
  );

  const next = {
    ...contract,
    ticker: 'KXBTC15M-NO-DAILY-CUTOFF',
    eventTicker: 'KXBTC15M-NO-DAILY-CUTOFF',
    startsAt: contract.expiresAt,
    expiresAt: contract.expiresAt + 900000,
  };
  clock += 15000;
  loadBook.mockImplementation(async () => ({ ...bookAt(clock), ticker: next.ticker }));
  await advance(next);
  const report = await service.getReport();
  expect(report.latestAdvice.action).toBe('buy');
  expect(report.latestAdvice.policy.dailyLossLimitEnabled).toBe(false);
  expect(report.latestAdvice.portfolio.dailyRealizedPnl).toBe(before.account.dailyRealizedPnl);
  expect(report.latestAdvice.portfolio.cash).toBe(before.account.cash);
  expect(report.portfolio.cash + report.portfolio.reservedCapital).toBeCloseTo(
    before.account.cash,
    7,
  );
  expect((await repository.readConfiguration()).revision).toBe(1);
});

test('reconfiguration of a profitable closed run preserves actual profit and risk history', async () => {
  await configure();
  await advance();
  clock += 2000;
  await advance();
  clock = contract.expiresAt;
  await advance();
  await service.stop();
  const before = await repository.readState(configuration.policy.id);
  const saved = await repository.configure({
    allocation: 25,
    riskLevel: 'conservative',
    expectedRevision: 1,
  });
  const after = await repository.readState(saved.policy.id);
  expect(after.account.realizedPnl).toBe(before.account.realizedPnl);
  expect(after.account.cash).toBeCloseTo(before.account.cash - 25, 7);
  expect(after.risk.history.peakEquity).toBeCloseTo(before.risk.history.peakEquity - 25, 7);
  expect((await repository.readState(configuration.policy.id)).account).toEqual(before.account);
});

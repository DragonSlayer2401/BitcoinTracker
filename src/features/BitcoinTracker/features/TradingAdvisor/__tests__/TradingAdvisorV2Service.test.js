/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import {
  createConfiguredTradingAdvisorService,
  createTradingAdvisorService,
} from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { createTradingPolicyTrialRepository } from '@/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createTradingPolicyTrialService } from '@/services/research/tradingAdvisor/tradingPolicyTrials.service';
import { createAdvisorHistoryTrialRepository } from '@/services/research/tradingAdvisor/advisorHistoryTrials.repository';
import { createAdvisorHistoryTrialService } from '@/services/research/tradingAdvisor/advisorHistoryTrials.service';
import { getTradingAdvice, TRADING_ADVISOR_POLICY } from '../utils/tradingAdvisor.utils';
import { createAdvisorResearchPolicy } from '../utils/advisorPolicy.utils';
import { START, bookAt, contract, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
let client;
let clock;
let repository;
let trialRepository;
let service;
let configuration;
let trialPolicyId;
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
  trialPolicyId = createAdvisorResearchPolicy(configuration.policy).id;
  await advance(); // Register before the next event starts, without reading a book.
  clock = START + 60000;
}

async function createTrialOrdersWithoutMainOrder() {
  await configure();
  await service.stop();
  // The main account entered earlier, while the registered trial accounts remained flat.
  service = createConfiguredTradingAdvisorService({
    repository,
    loadBook,
    loadMarket,
    now: () => clock,
  });
  await advance();
  clock += 2000;
  await advance();
  await service.stop();

  clock += 13000;
  service = makeService();
  await advance();
  const main = await service.getReport();
  expect(main.latestAdvice.action).toBe('hold');
  expect(main.portfolio.pendingIntents).toHaveLength(0);
  expect(main.portfolio.positions).toHaveLength(1);
  const trial = await trialRepository.readState(trialPolicyId);
  expect(Object.keys(trial.strategies).sort()).toEqual([
    'cautious-sizing',
    'early-exit',
    'selective-entry',
    'standard',
  ]);
  for (const strategy of Object.values(trial.strategies)) {
    expect(strategy.latestAdvice.action).toBe('buy');
    expect(strategy.account.pendingIntents).toHaveLength(1);
  }
  loadBook.mockClear();
}

async function createOrdersWithBothTrialFamilies(historyDelayMs = 0) {
  configuration = await repository.configure({
    allocation: 50,
    riskLevel: 'balanced',
    expectedRevision: 0,
  });
  trialPolicyId = configuration.policy.id;
  const historyRepository = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  const provider = {
    configuration: {
      enabled: false,
      model: 'test-disabled-model',
      promptVersion: 'test-prompt-v1',
      minimumRequestIntervalMs: 30000,
    },
    invoke: jest.fn(),
  };
  const historyTrials = createAdvisorHistoryTrialService({
    repository: historyRepository,
    policy: configuration.policy,
    provider,
    now: () => clock,
  });
  service = createTradingAdvisorService({
    repository: {
      ...repository,
      async saveAdvice(input) {
        const advice = await repository.saveAdvice(input);
        // History observes the saved main decision after its persistence completes.
        clock += historyDelayMs;
        return advice;
      },
    },
    policy: configuration.policy,
    trials: createTradingPolicyTrialService({ repository: trialRepository, now: () => clock }),
    historyTrials,
    loadBook,
    loadMarket,
    now: () => clock,
  });
  await advance();
  const historyId = (await historyTrials.start()).id;
  clock = START + 60000;
  const decidedAt = clock;
  await advance();
  expect((await service.getReport()).portfolio.pendingIntents).toHaveLength(1);
  const policyTrial = await trialRepository.readState(trialPolicyId);
  for (const strategy of Object.values(policyTrial.strategies))
    expect(strategy.account.pendingIntents).toHaveLength(1);
  const history = await historyRepository.readState(historyId);
  expect(history.strategies.incumbent.account.pendingIntents).toHaveLength(1);
  expect(history.strategies.incumbent.account.pendingIntents[0].evaluatedAt).toBe(
    decidedAt + historyDelayMs,
  );
  expect(provider.invoke).not.toHaveBeenCalled();
  loadBook.mockClear();
  return { historyRepository, historyId, decidedAt };
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
  const trial = await trialRepository.readState(trialPolicyId);
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

test.each([false, true])(
  'trial-only orders share one execution book at the minimum delay, including after restart: %s',
  async (restart) => {
    await createTrialOrdersWithoutMainOrder();
    if (restart) {
      await service.stop();
      service = makeService();
    }
    const decidedAt = clock;
    clock = decidedAt + 1999;
    await advance();
    expect(loadBook).not.toHaveBeenCalled();
    const waiting = await trialRepository.readState(trialPolicyId);
    for (const strategy of Object.values(waiting.strategies)) {
      expect(strategy.account.pendingIntents).toHaveLength(1);
      expect(strategy.account.positions).toHaveLength(0);
    }

    clock = decidedAt + 2000;
    await advance();
    expect(loadBook).toHaveBeenCalledTimes(1);
    expect(loadBook).toHaveBeenCalledWith(contract.ticker);
    const filled = await trialRepository.readState(trialPolicyId);
    for (const strategy of Object.values(filled.strategies)) {
      expect(strategy.account.pendingIntents).toHaveLength(0);
      expect(strategy.account.positions).toHaveLength(1);
      expect(filled.contracts[0].scores[strategy.id].orderFills).toBe(1);
    }
    const main = await service.getReport();
    expect(main.latestAdvice.action).toBe('hold');
    expect(main.portfolio.pendingIntents).toHaveLength(0);
    await advance();
    clock += 1;
    await advance();
    expect(loadBook).toHaveBeenCalledTimes(1);
  },
);

test.each(['missing', 'rejected', 'late'])(
  'a %s shared trial execution observation cancels every due order without a favorable retry',
  async (failure) => {
    await createTrialOrdersWithoutMainOrder();
    loadBook.mockImplementation(async () => {
      if (failure === 'rejected') throw new Error('Book unavailable');
      if (failure === 'missing') return null;
      clock += 14000;
      return bookAt(clock);
    });
    clock += 2000;
    await advance(null);
    expect(loadBook).toHaveBeenCalledTimes(1);
    const canceled = await trialRepository.readState(trialPolicyId);
    for (const strategy of Object.values(canceled.strategies)) {
      expect(strategy.account.pendingIntents).toHaveLength(0);
      expect(strategy.account.positions).toHaveLength(0);
      expect(strategy.account.cash).toBe(50);
      expect(canceled.contracts[0].scores[strategy.id].orderFills).toBe(0);
    }

    loadBook.mockImplementation(async () => bookAt(clock));
    await service.stop();
    service = makeService();
    clock += 1;
    await advance(null);
    expect(loadBook).toHaveBeenCalledTimes(1);
    expect((await trialRepository.readState(trialPolicyId)).strategies).toEqual(
      canceled.strategies,
    );
  },
);

test('expired trial-only orders release reservations without requesting an execution book', async () => {
  await createTrialOrdersWithoutMainOrder();
  clock += 15001;
  await advance(null);
  expect(loadBook).not.toHaveBeenCalled();
  const expired = await trialRepository.readState(trialPolicyId);
  for (const strategy of Object.values(expired.strategies)) {
    expect(strategy.account.pendingIntents).toHaveLength(0);
    expect(strategy.account.positions).toHaveLength(0);
    expect(strategy.account.cash).toBe(50);
    expect(expired.contracts[0].scores[strategy.id].orderFills).toBe(0);
  }
});

test('one delayed book fills the main account and every eligible policy and history account', async () => {
  const { historyRepository, historyId, decidedAt } = await createOrdersWithBothTrialFamilies();
  clock = decidedAt + 1999;
  await advance();
  expect(loadBook).not.toHaveBeenCalled();
  clock = decidedAt + 2000;
  await advance();
  expect(loadBook).toHaveBeenCalledTimes(1);
  const main = await service.getReport();
  expect(main.portfolio.pendingIntents).toHaveLength(0);
  expect(main.portfolio.positions).toHaveLength(1);
  const policyTrial = await trialRepository.readState(trialPolicyId);
  for (const strategy of Object.values(policyTrial.strategies)) {
    expect(strategy.account.pendingIntents).toHaveLength(0);
    expect(strategy.account.positions).toHaveLength(1);
  }
  const history = await historyRepository.readState(historyId);
  expect(history.strategies.incumbent.account.pendingIntents).toHaveLength(0);
  expect(history.strategies.incumbent.account.positions).toHaveLength(1);
  expect(history.strategies.incumbent.account.cash).toBe(main.portfolio.cash);
  clock += 1;
  await advance();
  expect(loadBook).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'rejected'])(
  'a %s common book cancels main, policy and history orders without a second history request',
  async (failure) => {
    const { historyRepository, historyId, decidedAt } = await createOrdersWithBothTrialFamilies();
    loadBook.mockImplementation(async () => {
      if (failure === 'rejected') throw new Error('Book unavailable');
      return null;
    });
    clock = decidedAt + 2000;
    await advance();
    expect(loadBook).toHaveBeenCalledTimes(1);
    const main = await service.getReport();
    const policyTrial = await trialRepository.readState(trialPolicyId);
    const history = await historyRepository.readState(historyId);
    const accounts = [
      main.portfolio,
      ...Object.values(policyTrial.strategies).map((strategy) => strategy.account),
      ...Object.values(history.strategies).map((strategy) => strategy.account),
    ];
    for (const account of accounts) {
      expect(account.pendingIntents).toHaveLength(0);
      expect(account.positions).toHaveLength(0);
      expect(account.cash).toBe(50);
    }
    loadBook.mockImplementation(async () => bookAt(clock));
    clock += 1;
    await advance();
    expect(loadBook).toHaveBeenCalledTimes(1);
  },
);

test('a history order becoming due during a common request waits for its own delayed observation', async () => {
  const { historyRepository, historyId, decidedAt } = await createOrdersWithBothTrialFamilies(20);
  loadBook.mockImplementationOnce(async () => {
    clock += 500;
    return bookAt(clock);
  });
  clock = decidedAt + 2000;
  await advance();
  expect(loadBook).toHaveBeenCalledTimes(1);
  expect((await service.getReport()).portfolio.positions).toHaveLength(1);
  const policyTrial = await trialRepository.readState(trialPolicyId);
  for (const strategy of Object.values(policyTrial.strategies))
    expect(strategy.account.positions).toHaveLength(1);
  const waiting = await historyRepository.readState(historyId);
  expect(waiting.strategies.incumbent.account.pendingIntents).toHaveLength(1);
  expect(waiting.strategies.incumbent.account.positions).toHaveLength(0);

  clock += 1;
  await advance();
  expect(loadBook).toHaveBeenCalledTimes(2);
  const filled = await historyRepository.readState(historyId);
  expect(filled.strategies.incumbent.account.pendingIntents).toHaveLength(0);
  expect(filled.strategies.incumbent.account.positions).toHaveLength(1);
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
  const trial = await trialRepository.readState(trialPolicyId);
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

test('a research strategy activation leaves original decisions, cash and account identity unchanged', async () => {
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
    args: [trialPolicyId, 1, clock, payload, createHash('sha256').update(payload).digest('hex')],
  });
  await advance();
  const after = await repository.readState(configuration.policy.id);
  const selectedAdvice = await repository.readAdvice(after.advice[0].id);
  expect(selectedAdvice.policy.strategyId).toBe('standard');
  expect(selectedAdvice.policy.minimumExitAdvantage).toBe(
    configuration.policy.minimumExitAdvantage,
  );
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

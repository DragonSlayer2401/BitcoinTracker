/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { getAdvisorPortfolio } from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { getAdvisorDecisionPortfolio } from '@/services/research/tradingAdvisor/advisorPortfolio.utils';
import { getCanonicalResearchJson } from '@/services/research/research.validation';
import { getAdvisorEntryRisk } from '../utils/advisorPolicy.utils';
import { TRADING_ADVISOR_POLICY, getTradingAdvice } from '../utils/tradingAdvisor.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });

const policy = TRADING_ADVISOR_POLICY;
let client;
let repository;
let clock;
let lease;

beforeEach(async () => {
  clock = START + 60_000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  await repository.ensurePolicy(policy, START);
});
afterEach(() => client.close());

const configure = (overrides = {}) =>
  repository.configure({
    allocation: 50,
    riskLevel: 'conservative',
    expectedRevision: 0,
    ...overrides,
  });

async function enterPosition({ fill = true } = {}) {
  lease = await repository.acquireLease(policy.id, 'configuration-test');
  const state = await repository.readState(policy.id);
  const book = bookAt(clock);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock);
  const portfolio = getAdvisorPortfolio(state.account, clock);
  const advice = {
    ...getTradingAdvice({ contract, forecast, book, portfolio, now: clock, policy }),
    id: `${policy.id}:${contract.ticker}:${clock}`,
    forecast,
    book,
    portfolio,
    accountVersion: state.account.version,
    validUntil: clock + policy.cadenceMs,
  };
  expect(advice.action).toBe('buy');
  await repository.saveAdvice({ advice, researchInputSnapshot, lease });
  if (fill) {
    clock += policy.minimumFillDelayMs;
    await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease });
    await repository.saveExecution({
      adviceId: advice.id,
      book: bookAt(clock),
      recordedAt: clock,
      observationAttemptToken: lease.token,
      lease,
    });
  }
  return advice;
}

async function settleLoss({ compare = true } = {}) {
  const advice = await enterPosition();
  await repository.releaseLease(lease);
  clock = contract.expiresAt + 1000;
  lease = await repository.acquireLease(policy.id, 'configuration-test');
  const settlement = {
    policyId: policy.id,
    positionId: `${advice.id}:position`,
    market: outcomeAt(clock, 'no'),
    recordedAt: clock,
    lease,
  };
  await repository.saveSettlement(settlement);
  if (compare) await repository.saveComparison(settlement);
  await repository.writeHeartbeat(
    { policyId: policy.id, status: 'stopped', heartbeatAt: clock },
    lease,
  );
  await repository.releaseLease(lease);
  return advice;
}

describe('paper adviser account configuration', () => {
  test('reading setup is read-only and retains the legacy policy until explicit configuration', async () => {
    expect(await repository.readConfiguration()).toEqual({
      revision: 0,
      configuredAt: null,
      policy,
    });
    expect((await repository.readState(policy.id)).account.cash).toBe(100);
    const history = await client.execute(
      'SELECT COUNT(*) AS count FROM advisor_configuration_history',
    );
    expect(Number(history.rows[0].count)).toBe(0);
  });

  test('moves a stopped flat account to a new allocation while preserving its real losses, fees and risk history', async () => {
    await settleLoss();
    const before = await repository.readState(policy.id);
    expect(before.account.realizedPnl).toBeLessThan(0);
    expect(before.account.feesPaid).toBeGreaterThan(0);
    expect(before.account.positions).toHaveLength(0);
    expect(before.account.pendingComparisons).toHaveLength(0);
    const result = await configure();
    expect(result).toMatchObject({
      revision: 1,
      configuredAt: clock,
      previousPolicyId: policy.id,
      carriedRealizedPnl: before.account.realizedPnl,
      policy: { version: 2, totalBudget: 50, initialBankroll: 50, riskLevel: 'conservative' },
    });
    const after = await repository.readState(result.policy.id);
    expect(after.account.cash).toBeCloseTo(before.account.cash - 50, 8);
    for (const field of [
      'realizedPnl',
      'realizedDay',
      'dailyRealizedPnl',
      'feesPaid',
      'performance',
    ]) {
      expect(after.account[field]).toEqual(before.account[field]);
    }
    expect(after.account.version).toBe(before.account.version + 1);
    expect(after.risk.valuation).toBeNull();
    expect(after.risk.history).toEqual({
      ...before.risk.history,
      peakEquity: before.risk.history.peakEquity - 50,
      historicalPeakEquity: before.risk.history.peakEquity,
    });
    expect((await repository.readState(policy.id)).account).toEqual(before.account);
    expect(await repository.acquireLease(policy.id, 'old-collector')).toBeNull();
    expect(await repository.acquireLease(result.policy.id, 'new-collector')).not.toBeNull();
    const restarted = createTradingAdvisorRepository({ client, now: () => clock });
    expect(await restarted.readConfiguration()).toEqual(result);
    await expect(client.execute('DELETE FROM advisor_configuration_history')).rejects.toThrow(
      'append-only',
    );
  });

  test('removing the daily cutoff retains recorded losses and the remaining drawdown allowance', async () => {
    await settleLoss();
    const oldAccount = (await repository.readState(policy.id)).account;
    const configured = await configure({ allocation: 100 });
    const state = await repository.readState(configured.policy.id);
    const portfolio = getAdvisorDecisionPortfolio({
      account: state.account,
      book: null,
      now: clock,
      policy: configured.policy,
      riskHistory: state.risk.history,
    });
    expect(portfolio.cash).toBe(oldAccount.cash);
    expect(portfolio.dailyRealizedPnl).toBe(oldAccount.dailyRealizedPnl);
    expect(configured.policy.dailyLossLimitEnabled).toBe(false);
    expect(portfolio.dailyRealizedPnl).toBeLessThan(-configured.policy.maxDailyLoss);
    const risk = getAdvisorEntryRisk({ portfolio, policy: configured.policy, now: clock });
    expect(risk.reason).toBeNull();
    expect(risk.budget).toBeGreaterThan(0);
    expect(risk.budget).toBeCloseTo(configured.policy.maxDrawdown + oldAccount.realizedPnl, 6);
  });

  test('rejects reductions that cannot cover already recorded losses without mutating either account', async () => {
    await settleLoss();
    const before = await repository.readState(policy.id);
    await expect(configure({ allocation: 1 })).rejects.toThrow('recorded losses');
    expect((await repository.readConfiguration()).revision).toBe(0);
    expect((await repository.readState(policy.id)).account).toEqual(before.account);
  });

  test('allows only one of two changes based on the same revision', async () => {
    const other = createTradingAdvisorRepository({ client, now: () => clock });
    const outcomes = await Promise.allSettled([
      configure(),
      other.configure({ allocation: 75, riskLevel: 'balanced', expectedRevision: 0 }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected').reason.message).toContain(
      'another window',
    );
    expect((await repository.readConfiguration()).revision).toBe(1);
    const history = await client.execute(
      'SELECT COUNT(*) AS count FROM advisor_configuration_history',
    );
    expect(Number(history.rows[0].count)).toBe(1);
  });

  test('requires the collector to stop even when it currently has no position', async () => {
    lease = await repository.acquireLease(policy.id, 'active-collector');
    await expect(configure()).rejects.toThrow('Stop the collector');
    await repository.writeHeartbeat(
      { policyId: policy.id, status: 'running', heartbeatAt: clock },
      lease,
    );
    await repository.releaseLease(lease);
    await expect(configure()).rejects.toThrow('Stop the collector');
    expect((await repository.readConfiguration()).revision).toBe(0);
    clock += 30_000;
    expect((await configure()).revision).toBe(1);
  });

  test.each(['pending order', 'open position', 'pending comparison'])(
    'rejects setup changes while a %s still owns account obligations',
    async (kind) => {
      if (kind === 'pending comparison') await settleLoss({ compare: false });
      else {
        await enterPosition({ fill: kind === 'open position' });
        await repository.releaseLease(lease);
      }
      await expect(configure()).rejects.toThrow(
        'open positions, pending orders and official settlement comparisons',
      );
      expect((await repository.readConfiguration()).revision).toBe(0);
    },
  );

  test.each([0, 0.01, 0.99, -1, 100.01, NaN, Infinity, 1.001, '50', null])(
    'rejects invalid allocation %s before enrolling another policy',
    async (allocation) => {
      await expect(configure({ allocation })).rejects.toThrow();
      expect((await repository.readConfiguration()).revision).toBe(0);
      const policies = await client.execute('SELECT COUNT(*) AS count FROM advisor_policies');
      expect(Number(policies.rows[0].count)).toBe(1);
    },
  );

  test.each([1, 37.25, 100])(
    'accepts an explicit cent-denominated allocation of %s',
    async (allocation) => {
      const saved = await configure({ allocation, riskLevel: 'balanced' });
      expect(saved.policy.initialBankroll).toBe(allocation);
      expect((await repository.readState(saved.policy.id)).account.cash).toBe(allocation);
    },
  );

  test.each([
    { riskLevel: 'aggressive' },
    { riskLevel: null },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: '0' },
    { expectedRevision: null },
  ])('rejects unsupported setup fields %j', async (overrides) => {
    await expect(configure(overrides)).rejects.toThrow();
    expect((await repository.readConfiguration()).revision).toBe(0);
  });

  test('does not turn a missing enrolled account into a fresh balance', async () => {
    await client.execute({
      sql: 'DELETE FROM advisor_accounts WHERE policy_id = ?',
      args: [policy.id],
    });
    await expect(configure()).rejects.toMatchObject({ code: 'ADVISOR_STORAGE_CORRUPT' });
    expect((await repository.readConfiguration()).revision).toBe(0);
  });

  test('rolls back enrollment and configuration together when the immutable audit write fails', async () => {
    await client.execute(`CREATE TRIGGER fail_configuration_history BEFORE INSERT ON advisor_configuration_history
      BEGIN SELECT RAISE(ABORT, 'test configuration audit failure'); END`);
    await expect(configure()).rejects.toThrow('test configuration audit failure');
    expect((await repository.readConfiguration()).revision).toBe(0);
    const policies = await client.execute('SELECT COUNT(*) AS count FROM advisor_policies');
    expect(Number(policies.rows[0].count)).toBe(1);
    expect((await repository.readState(policy.id)).account.cash).toBe(100);
  });
});

test('a recovered account can reduce allocation below its historic drawdown and still record new advice', async () => {
  // The account recovered to $100 after an earlier $40 drawdown. The dollar history must
  // remain intact when the user withdraws $80 from the simulated allocation.
  const history = {
    startedAt: START,
    lastObservedAt: clock,
    lastCompleteAt: clock,
    observationCount: 3,
    completeCount: 3,
    incompleteCount: 0,
    peakEquity: 100,
    maxDrawdown: 40,
    drawdown: 0,
  };
  const payload = getCanonicalResearchJson({ valuation: null, history });
  await client.execute({
    sql: 'INSERT INTO advisor_risk_state(policy_id, payload, content_hash) VALUES (?, ?, ?)',
    args: [policy.id, payload, createHash('sha256').update(payload).digest('hex')],
  });
  const configured = await configure({ allocation: 20 });
  let state = await repository.readState(configured.policy.id);
  expect(state.account.cash).toBe(20);
  expect(state.risk.history).toMatchObject({
    peakEquity: 20,
    maxDrawdown: 40,
    historicalPeakEquity: 100,
  });
  clock += configured.policy.cadenceMs;
  const nextLease = await repository.acquireLease(configured.policy.id, 'configured-collector');
  const book = bookAt(clock);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock);
  const portfolio = getAdvisorDecisionPortfolio({
    account: state.account,
    book,
    now: clock,
    policy: configured.policy,
    riskHistory: state.risk.history,
  });
  const advice = {
    ...getTradingAdvice({
      contract,
      forecast,
      book,
      portfolio,
      now: clock,
      policy: configured.policy,
    }),
    id: `${configured.policy.id}:${contract.ticker}:${clock}`,
    forecast,
    book,
    portfolio,
    accountVersion: state.account.version,
    validUntil: clock + configured.policy.cadenceMs,
  };
  expect(advice.action).toBe('buy');
  await repository.saveAdvice({ advice, researchInputSnapshot, lease: nextLease });
  state = await repository.readState(configured.policy.id);
  expect(state.advice[0].id).toBe(advice.id);
  expect(state.risk.history).toMatchObject({
    observationCount: 4,
    peakEquity: 20,
    maxDrawdown: 40,
    historicalPeakEquity: 100,
  });
  expect(state.risk.valuation.executableEquity).toBe(20);
});

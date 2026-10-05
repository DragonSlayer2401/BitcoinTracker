/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { getAdvisorPortfolio } from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { createConfiguredTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { createTradingPolicyTrialRepository } from '@/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createTradingPolicyTrialService } from '@/services/research/tradingAdvisor/tradingPolicyTrials.service';
import {
  createAdvisorResearchPolicy,
  createTradingAdvisorPolicy,
} from '../utils/advisorPolicy.utils';
import { getTradingAdvice, TRADING_ADVISOR_POLICY } from '../utils/tradingAdvisor.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
let client;
let repository;
let clock;
let lease;
const legacyPolicy = TRADING_ADVISOR_POLICY;
beforeEach(async () => {
  clock = START + 60000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  await repository.ensurePolicy(legacyPolicy, START);
});
afterEach(() => client.close());

async function saveLegacyAdvice() {
  lease = await repository.acquireLease(legacyPolicy.id, 'migration-fixture');
  const state = await repository.readState(legacyPolicy.id);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock);
  const portfolio = getAdvisorPortfolio(state.account, clock);
  const book = bookAt(clock);
  const advice = {
    ...getTradingAdvice({ contract, forecast, book, portfolio, now: clock, policy: legacyPolicy }),
    id: `migration:${clock}`,
    forecast,
    book,
    portfolio,
    accountVersion: state.account.version,
    validUntil: clock + legacyPolicy.cadenceMs,
  };
  await repository.saveAdvice({ advice, researchInputSnapshot, lease });
  return advice;
}

async function fillLegacy() {
  const advice = await saveLegacyAdvice();
  clock += legacyPolicy.minimumFillDelayMs;
  await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease });
  await repository.saveExecution({
    adviceId: advice.id,
    book: bookAt(clock),
    recordedAt: clock,
    observationAttemptToken: lease.token,
    lease,
  });
  await repository.releaseLease(lease);
  return advice;
}

async function settleLegacy(result = 'no') {
  const advice = await fillLegacy();
  clock = contract.expiresAt + 1000;
  lease = await repository.acquireLease(legacyPolicy.id, 'migration-fixture');
  const positionId = (await repository.readState(legacyPolicy.id)).account.positions[0].id;
  await repository.saveSettlement({
    policyId: legacyPolicy.id,
    positionId,
    market: outcomeAt(clock, result),
    recordedAt: clock,
    lease,
  });
  await repository.saveComparison({
    policyId: legacyPolicy.id,
    positionId,
    market: outcomeAt(clock, result),
    recordedAt: clock,
    lease,
  });
  await repository.releaseLease(lease);
  return advice;
}

function encode(value) {
  const payload = JSON.stringify(value);
  return { payload, hash: createHash('sha256').update(payload).digest('hex') };
}

async function setOldV2Configuration() {
  const policy = createTradingAdvisorPolicy({
    allocation: 50,
    riskLevel: 'balanced',
    runId: 'old-daily-cutoff',
    dailyLossLimitEnabled: true,
  });
  await repository.ensurePolicy(policy, START);
  const configuration = {
    revision: 1,
    configuredAt: START,
    policy,
    previousPolicyId: legacyPolicy.id,
    carriedRealizedPnl: 0,
  };
  const row = encode(configuration);
  await client.execute({
    sql: 'INSERT INTO advisor_configuration VALUES (1, ?, ?)',
    args: [row.payload, row.hash],
  });
  return configuration;
}

test('rolls over a funded account without restoring losses, wiping drawdown, or altering archived advice', async () => {
  const advice = await settleLegacy();
  const before = await repository.readState(legacyPolicy.id);
  expect(before.account.dailyRealizedPnl).toBeLessThan(-5);
  const savedAdvice = await repository.readAdvice(advice.id, { includeInputs: true });
  const configuration = await repository.ensureDailyLossLimitRemoved();
  expect(configuration.revision).toBe(1);
  expect(configuration.policy.id).toMatch(/^kalshi-advisor-v3-/);
  expect(configuration.policy.dailyLossLimitEnabled).toBe(false);
  const migrated = await repository.readState(configuration.policy.id);
  expect(migrated.account).toEqual({ ...before.account, version: before.account.version + 1 });
  expect(migrated.risk.history).toEqual(before.risk.history);
  expect(migrated.risk.valuation).toBeNull();
  expect((await repository.readState(legacyPolicy.id)).account).toEqual(before.account);
  expect(await repository.readAdvice(advice.id, { includeInputs: true })).toEqual(savedAdvice);
  const replay = getTradingAdvice({
    contract: savedAdvice.contract,
    forecast: savedAdvice.forecast,
    book: savedAdvice.book,
    portfolio: savedAdvice.portfolio,
    now: savedAdvice.evaluatedAt,
    policy: savedAdvice.policy,
  });
  for (const [key, value] of Object.entries(replay)) expect(savedAdvice[key]).toEqual(value);
  expect(await repository.acquireLease(legacyPolicy.id, 'retired-writer')).toBeNull();
  expect(await repository.ensureDailyLossLimitRemoved()).toEqual(configuration);
  expect((await repository.readState(configuration.policy.id)).account).toEqual(migrated.account);
});

test('moves an open position and its pending comparison intact and settles them under the new policy', async () => {
  await fillLegacy();
  const before = await repository.readState(legacyPolicy.id);
  expect(before.account.positions).toHaveLength(1);
  expect(before.account.pendingComparisons).toHaveLength(1);
  const configuration = await repository.ensureDailyLossLimitRemoved();
  const migrated = await repository.readState(configuration.policy.id);
  expect(migrated.account.positions).toEqual(before.account.positions);
  expect(migrated.account.pendingComparisons).toEqual(before.account.pendingComparisons);
  expect(migrated.account.cash).toBe(before.account.cash);
  clock = contract.expiresAt + 1000;
  lease = await repository.acquireLease(configuration.policy.id, 'new-writer');
  const positionId = migrated.account.positions[0].id;
  await repository.saveSettlement({
    policyId: configuration.policy.id,
    positionId,
    market: outcomeAt(clock),
    recordedAt: clock,
    lease,
  });
  await repository.saveComparison({
    policyId: configuration.policy.id,
    positionId,
    market: outcomeAt(clock),
    recordedAt: clock,
    lease,
  });
  const settled = await repository.readState(configuration.policy.id);
  expect(settled.account.positions).toHaveLength(0);
  expect(settled.account.pendingComparisons).toHaveLength(0);
  expect(settled.account.cash).toBeCloseTo(
    before.account.cash + before.account.positions[0].quantity,
    7,
  );
  expect((await repository.readState(legacyPolicy.id)).account).toEqual(before.account);
});

test('defers while an intention reserves cash, then migrates after its single execution resolves', async () => {
  const advice = await saveLegacyAdvice();
  await repository.releaseLease(lease);
  const original = await repository.readConfiguration();
  expect(await repository.ensureDailyLossLimitRemoved()).toEqual(original);
  expect((await repository.readState(legacyPolicy.id)).account.pendingIntents).toHaveLength(1);
  clock += legacyPolicy.minimumFillDelayMs;
  lease = await repository.acquireLease(legacyPolicy.id, 'migration-fixture');
  await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease });
  await repository.saveExecution({
    adviceId: advice.id,
    book: bookAt(clock),
    recordedAt: clock,
    observationAttemptToken: lease.token,
    lease,
  });
  await repository.releaseLease(lease);
  expect((await repository.ensureDailyLossLimitRemoved()).policy.dailyLossLimitEnabled).toBe(false);
});

test('a slow collector drains an expired legacy order without creating another order that starves migration', async () => {
  const advice = await saveLegacyAdvice();
  await repository.releaseLease(lease);
  clock += legacyPolicy.maximumFillDelayMs + 1000;
  const loadBook = jest.fn(async () => bookAt(clock));
  const getForecast = jest.fn(() => forecastAt(clock));
  const service = createConfiguredTradingAdvisorService({
    repository,
    now: () => clock,
    loadBook,
    loadMarket: async () => null,
  });
  await service.advance({ market: contract, getForecast });
  const drained = await repository.readState(legacyPolicy.id);
  expect(drained.account.pendingIntents).toHaveLength(0);
  expect(drained.account.cash).toBe(100);
  expect(drained.advice).toHaveLength(1);
  expect(drained.advice[0].id).toBe(advice.id);
  expect(drained.events[0]).toMatchObject({ kind: 'no-fill', reason: 'execution_window_expired' });
  expect((await repository.readConfiguration()).policy.id).toBe(legacyPolicy.id);
  expect(loadBook).not.toHaveBeenCalled();
  expect(getForecast).not.toHaveBeenCalled();
  clock += 1;
  await service.advance({ market: contract, getForecast });
  const report = await service.getReport();
  expect(report.policy.id).not.toBe(legacyPolicy.id);
  expect(report.policy.dailyLossLimitEnabled).toBe(false);
  expect(report.latestAdvice.action).toBe('buy');
  expect(report.latestAdvice.policyId).toBe(report.policy.id);
  expect(report.portfolio.cash + report.portfolio.reservedCapital).toBeCloseTo(100, 7);
  expect(loadBook).toHaveBeenCalledTimes(1);
  expect((await repository.readState(legacyPolicy.id)).advice).toHaveLength(1);
});

test('defers for another live writer, and retries after the lease expires without stealing its token', async () => {
  lease = await repository.acquireLease(legacyPolicy.id, 'busy-writer');
  const before = await repository.readConfiguration();
  expect(await repository.ensureDailyLossLimitRemoved()).toEqual(before);
  const held = await client.execute({
    sql: 'SELECT token FROM advisor_leases WHERE policy_id = ?',
    args: [legacyPolicy.id],
  });
  expect(held.rows[0].token).toBe(lease.token);
  clock = lease.expiresAt + 1;
  const configuration = await repository.ensureDailyLossLimitRemoved();
  expect(configuration.policy.dailyLossLimitEnabled).toBe(false);
  expect(await repository.acquireLease(legacyPolicy.id, 'busy-writer')).toBeNull();
});

test('v2 rollover preserves all risk and sizing rules except the daily cutoff and assigns a fresh trial identity', async () => {
  const previous = await setOldV2Configuration();
  const before = await repository.readState(previous.policy.id);
  const configuration = await repository.ensureDailyLossLimitRemoved();
  expect(configuration.revision).toBe(2);
  expect(configuration.policy.id).not.toBe(previous.policy.id);
  expect(configuration.policy.id).toMatch(/^kalshi-advisor-v2-/);
  expect(configuration.policy).toEqual({
    ...previous.policy,
    id: configuration.policy.id,
    dailyLossLimitEnabled: false,
  });
  expect((await repository.readState(configuration.policy.id)).account).toEqual({
    ...before.account,
    version: before.account.version + 1,
  });
  expect(await repository.acquireLease(previous.policy.id, 'retired-v2-writer')).toBeNull();
});

test('already-disabled configured policies do not create another account or configuration revision', async () => {
  const configuration = await repository.configure({
    allocation: 50,
    riskLevel: 'balanced',
    expectedRevision: 0,
  });
  expect(configuration.policy.dailyLossLimitEnabled).toBe(false);
  const rows = await client.execute('SELECT id FROM advisor_policies');
  expect(await repository.ensureDailyLossLimitRemoved()).toEqual(configuration);
  expect((await client.execute('SELECT id FROM advisor_policies')).rows).toEqual(rows.rows);
});

test('configured advance removes the legacy daily stop without increasing bankroll or waiting for setup', async () => {
  await settleLegacy();
  const before = await repository.readState(legacyPolicy.id);
  const nextContract = {
    ...contract,
    ticker: 'KXBTC15M-MIGRATION-NEXT',
    eventTicker: 'KXBTC15M-MIGRATION-NEXT',
    startsAt: contract.expiresAt,
    expiresAt: contract.expiresAt + 900000,
  };
  clock += 1000;
  const service = createConfiguredTradingAdvisorService({
    repository,
    now: () => clock,
    loadBook: async () => ({ ...bookAt(clock), ticker: nextContract.ticker }),
    loadMarket: async () => null,
  });
  await service.advance({ market: nextContract, getForecast: () => forecastAt(clock) });
  const report = await service.getReport();
  expect(report.policy.dailyLossLimitEnabled).toBe(false);
  expect(report.latestAdvice.action).toBe('buy');
  expect(report.portfolio.realizedPnl).toBe(before.account.realizedPnl);
  expect(report.portfolio.cash + report.portfolio.reservedCapital).toBeCloseTo(
    before.account.cash,
    7,
  );
});

test('a fully closed position still receives its pending official comparison after rollover', async () => {
  await fillLegacy();
  clock = contract.expiresAt + 1000;
  lease = await repository.acquireLease(legacyPolicy.id, 'migration-fixture');
  const positionId = (await repository.readState(legacyPolicy.id)).account.positions[0].id;
  await repository.saveSettlement({
    policyId: legacyPolicy.id,
    positionId,
    market: outcomeAt(clock),
    recordedAt: clock,
    lease,
  });
  await repository.releaseLease(lease);
  const before = await repository.readState(legacyPolicy.id);
  expect(before.account.positions).toHaveLength(0);
  expect(before.account.pendingComparisons).toHaveLength(1);
  const configuration = await repository.ensureDailyLossLimitRemoved();
  lease = await repository.acquireLease(configuration.policy.id, 'new-writer');
  await repository.saveComparison({
    policyId: configuration.policy.id,
    positionId,
    market: outcomeAt(clock),
    recordedAt: clock,
    lease,
  });
  const state = await repository.readState(configuration.policy.id);
  expect(state.account.pendingComparisons).toHaveLength(0);
  expect(state.account.performance.pairedPositionCount).toBe(1);
  expect(state.account.cash).toBe(before.account.cash);
  expect(state.account.realizedPnl).toBe(before.account.realizedPnl);
});

test('concurrent migration attempts produce one new policy and one retirement record', async () => {
  const configurations = await Promise.all(
    Array.from({ length: 4 }, () => repository.ensureDailyLossLimitRemoved()),
  );
  expect(new Set(configurations.map((configuration) => configuration.policy.id)).size).toBe(1);
  expect(configurations.every((configuration) => configuration.revision === 1)).toBe(true);
  expect((await client.execute('SELECT id FROM advisor_policies')).rows).toHaveLength(2);
  expect(
    (await client.execute('SELECT revision FROM advisor_configuration_history')).rows,
  ).toHaveLength(1);
});

test('a migrated v2 policy starts fresh prospective trials and leaves the old sample untouched', async () => {
  const previous = await setOldV2Configuration();
  const trialRepository = createTradingPolicyTrialRepository({ client, now: () => clock });
  const oldTrials = createTradingPolicyTrialService({
    repository: trialRepository,
    now: () => clock,
  });
  await oldTrials.ensureTrial(previous.policy, START);
  await oldTrials.observe({
    contract,
    forecast: forecastAt(clock),
    book: bookAt(clock),
    observedAt: clock,
  });
  const oldState = await trialRepository.readState(previous.policy.id);
  expect(oldState.contracts).toHaveLength(1);
  const service = createConfiguredTradingAdvisorService({
    repository,
    trialRepository,
    now: () => clock,
    loadBook: async () => bookAt(clock),
    loadMarket: async () => null,
  });
  await service.advance({ market: contract, getForecast: () => forecastAt(clock) });
  const report = await service.getReport();
  expect(report.policy.id).not.toBe(previous.policy.id);
  expect(report.policy.dailyLossLimitEnabled).toBe(false);
  expect(report.trials.registeredAt).toBe(clock);
  expect(report.trials.policyId).toBe(createAdvisorResearchPolicy(report.policy).id);
  expect(report.trials.maxEntryContracts).toBe(1);
  expect(report.trials.enrolledContracts).toBe(0);
  expect(report.trials.activeStrategyId).toBe('standard');
  expect(await trialRepository.readState(previous.policy.id)).toEqual(oldState);
});

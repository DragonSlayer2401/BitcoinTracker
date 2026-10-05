/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import {
  createTradingPolicyTrialRepository,
  getTradingPolicySelection,
} from '@/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createTradingPolicyTrialService } from '@/services/research/tradingAdvisor/tradingPolicyTrials.service';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { START, bookAt, contract, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
let client;
let repository;
let service;
let clock;
const policy = createTradingAdvisorPolicy({
  allocation: 50,
  riskLevel: 'balanced',
  runId: 'storage-trial',
});
beforeEach(async () => {
  clock = START - 1000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingPolicyTrialRepository({ client, now: () => clock });
  service = createTradingPolicyTrialService({ repository, now: () => clock });
  await service.ensureTrial(policy, clock);
});
afterEach(() => client.close());

test('reports each funded experiment separately without replacing earlier balances or evidence', async () => {
  clock = START + 60000;
  await service.observe({ contract, book: bookAt(clock), forecast: forecastAt(clock) });
  clock += 2000;
  await service.observe({ contract, book: bookAt(clock) });
  clock = contract.expiresAt;
  await service.settle({ market: outcomeAt(clock, 'no') });
  const prior = await repository.readState(policy.id);
  expect(prior.strategies.standard.account.realizedPnl).toBeLessThan(0);
  const nextPolicy = createTradingAdvisorPolicy({
    allocation: 50,
    riskLevel: 'balanced',
    runId: 'next-storage-trial',
  });
  clock += 1;
  await repository.ensureTrial(nextPolicy, clock);

  const reports = await repository.getReports();
  expect(reports.map((report) => report.policyId)).toEqual([nextPolicy.id, policy.id]);
  expect(reports[0]).toMatchObject({ initialBankroll: 50, maxEntryContracts: null });
  expect(reports[0].strategies.find((strategy) => strategy.id === 'standard')).toMatchObject({
    accountId: `${nextPolicy.id}:standard`,
    cash: 50,
    realizedPnl: 0,
    fillCount: 0,
  });
  expect(reports[1].strategies.find((strategy) => strategy.id === 'standard')).toMatchObject({
    accountId: `${policy.id}:standard`,
    cash: prior.strategies.standard.account.cash,
    realizedPnl: prior.strategies.standard.account.realizedPnl,
  });
  expect(await repository.readState(policy.id)).toEqual(prior);
});

test('registration survives restart and rejects rewriting the same strategy or using a future registration', async () => {
  expect((await repository.readState(policy.id)).registeredAt).toBe(START - 1000);
  const restarted = createTradingPolicyTrialRepository({ client, now: () => clock });
  await restarted.ensureTrial(policy, clock);
  expect((await restarted.readState(policy.id)).strategies.standard.account.cash).toBe(50);
  await expect(restarted.ensureTrial({ ...policy, totalBudget: 100 }, clock)).rejects.toThrow(
    'cannot be rewritten',
  );
  await expect(restarted.ensureTrial(policy, clock + 1)).rejects.toThrow('future');
  await expect(client.execute('DELETE FROM advisor_profit_trials')).rejects.toThrow('append-only');
});

test('captures a shared observation exactly once and prohibits changed duplicate evidence', async () => {
  clock = START + 60000;
  const input = { contract, book: bookAt(clock), forecast: forecastAt(clock), observedAt: clock };
  await service.observe(input);
  const first = await repository.readState(policy.id);
  await service.observe(input);
  expect(await repository.readState(policy.id)).toEqual(first);
  const observations = await client.execute('SELECT payload FROM advisor_profit_observations');
  expect(observations.rows).toHaveLength(1);
  expect(JSON.parse(observations.rows[0].payload).forecast.researchInputSnapshot).toBeUndefined();
  await expect(
    service.observe({ ...input, forecast: { ...forecastAt(clock), aboveProbability: 0.4 } }),
  ).rejects.toThrow('cannot be rewritten');
  await expect(
    client.execute("UPDATE advisor_profit_observations SET payload = '{}'"),
  ).rejects.toThrow('append-only');
});

test('later execution and official outcome preserve fees and account balances across service restart', async () => {
  clock = START + 60000;
  await service.observe({ contract, book: bookAt(clock), forecast: forecastAt(clock) });
  clock += 2000;
  await service.observe({ contract, book: bookAt(clock) });
  clock = contract.expiresAt;
  await service.settle({ market: outcomeAt(clock) });
  const restarted = createTradingPolicyTrialService({ repository, now: () => clock });
  const report = await restarted.getReport(policy.id);
  expect(report.resolvedContracts).toBe(1);
  expect(report.phase).toBe('collecting');
  const state = await repository.readState(policy.id);
  expect(state.strategies.standard.account.feesPaid).toBeGreaterThan(0);
  expect(state.strategies.standard.account.cash).toBeCloseTo(
    50 + state.contracts[0].scores.standard.netProfit,
    7,
  );
  expect(await restarted.getActivePolicy(policy, clock)).toEqual(policy);
});

test('a shared execution claim survives repository restart and expires without another opportunity', async () => {
  clock = START + 60000;
  const evaluatedAt = clock;
  await service.observe({ contract, book: bookAt(clock), forecast: forecastAt(clock) });
  expect(await service.getPendingExecutions()).toHaveLength(4);
  clock += policy.minimumFillDelayMs;
  const claim = await service.claimExecutionObservation(contract, clock);
  expect(claim).toMatchObject({
    sourceId: expect.any(String),
    requestedAt: clock,
    deadline: evaluatedAt + policy.maximumFillDelayMs + 1,
  });

  const restartedRepository = createTradingPolicyTrialRepository({ client, now: () => clock });
  const restarted = createTradingPolicyTrialService({
    repository: restartedRepository,
    now: () => clock,
  });
  await restarted.ensureTrial(policy);
  for (const { attempt } of await restarted.getPendingExecutions()) expect(attempt).toEqual(claim);
  clock += 1000;
  expect(await restarted.claimExecutionObservation(contract, clock)).toBeNull();
  await restarted.observe({ contract, book: bookAt(clock) });
  const pending = await restarted.getPendingExecutions();
  expect(pending).toHaveLength(4);
  for (const { attempt } of pending) expect(attempt).toEqual(claim);
  const unresolved = await restartedRepository.readState(policy.id);
  for (const strategy of Object.values(unresolved.strategies))
    expect(strategy.account.positions).toHaveLength(0);

  clock = evaluatedAt + policy.maximumFillDelayMs + 1;
  await restarted.observe({ contract, book: null });
  expect(await restarted.getPendingExecutions()).toHaveLength(0);
  const expired = await restartedRepository.readState(policy.id);
  for (const strategy of Object.values(expired.strategies)) {
    expect(strategy.account.cash).toBe(50);
    expect(strategy.account.positions).toHaveLength(0);
    expect(expired.contracts[0].scores[strategy.id].orderFills).toBe(0);
  }
});

test('a matching failed shared observation releases reservations exactly once and cannot be reclaimed', async () => {
  clock = START + 60000;
  await service.observe({ contract, book: bookAt(clock), forecast: forecastAt(clock) });
  clock += policy.minimumFillDelayMs;
  const claim = await service.claimExecutionObservation(contract, clock);
  clock += 1;
  const observation = {
    contract,
    sourceId: claim.sourceId,
    book: null,
    observedAt: clock,
  };
  await service.observe(observation);
  const resolved = await repository.readState(policy.id);
  await service.observe(observation);
  expect(await repository.readState(policy.id)).toEqual(resolved);
  expect(await service.getPendingExecutions()).toHaveLength(0);
  for (const strategy of Object.values(resolved.strategies)) {
    expect(strategy.account.cash).toBe(50);
    expect(strategy.account.positions).toHaveLength(0);
    expect(resolved.contracts[0].scores[strategy.id].orderFills).toBe(0);
  }

  clock += 1000;
  expect(await service.claimExecutionObservation(contract, clock)).toBeNull();
  await service.observe({ contract, book: bookAt(clock) });
  const later = await repository.readState(policy.id);
  for (const strategy of Object.values(later.strategies)) {
    expect(strategy.account.cash).toBe(50);
    expect(strategy.account.positions).toHaveLength(0);
    expect(later.contracts[0].scores[strategy.id].orderFills).toBe(0);
  }
});

test('freezes inputs before asynchronous persistence rather than accepting mutation after capture', async () => {
  clock = START + 60000;
  const input = {
    kind: 'observation',
    observedAt: clock,
    contract: { ...contract },
    book: bookAt(clock),
    forecast: forecastAt(clock),
  };
  const saved = repository.record(policy.id, input);
  input.forecast.aboveProbability = 0;
  await saved;
  const evidence = await client.execute('SELECT payload FROM advisor_profit_observations');
  expect(JSON.parse(evidence.rows[0].payload).forecast.aboveProbability).toBe(0.85);
  expect((await repository.readState(policy.id)).strategies.standard.latestAdvice.side).toBe('yes');
});

test('does not expose later promotions or rollback decisions to an earlier adviser replay', async () => {
  const activatedAt = START + 120 * 900000;
  const rollbackAt = activatedAt + 40 * 900000;
  async function insertTransition(sequence, transition) {
    const payload = JSON.stringify(transition);
    await client.execute({
      sql: 'INSERT INTO advisor_profit_transitions VALUES (?, ?, ?, ?, ?)',
      args: [
        policy.id,
        sequence,
        transition.at,
        payload,
        createHash('sha256').update(payload).digest('hex'),
      ],
    });
  }
  await insertTransition(1, { at: activatedAt, kind: 'activated', strategyId: 'cautious-sizing' });
  await insertTransition(2, { at: rollbackAt, kind: 'rolled-back', strategyId: 'standard' });
  expect(await getTradingPolicySelection(client, policy.id, START - 1001)).toBeNull();
  expect(await getTradingPolicySelection(client, policy.id, activatedAt - 1)).toEqual(policy);
  const selected = await getTradingPolicySelection(client, policy.id, activatedAt);
  expect(selected.id).toBe(policy.id);
  expect(selected.fractionalKelly).toBe(0.125);
  expect(selected.initialBankroll).toBe(50);
  expect(selected.maxDailyLoss).toBe(policy.maxDailyLoss);
  expect(await getTradingPolicySelection(client, policy.id, rollbackAt)).toEqual(policy);
  expect(await getTradingPolicySelection(client, 'unknown', rollbackAt)).toBeNull();
});

test('detects corrupted materialized evidence and rolls back invalid chronological writes', async () => {
  clock = START + 60000;
  await service.observe({ contract, book: bookAt(clock), forecast: forecastAt(clock) });
  await expect(service.observe({ contract, observedAt: clock - 1 })).rejects.toThrow(
    'chronological',
  );
  expect((await client.execute('SELECT id FROM advisor_profit_observations')).rows).toHaveLength(1);
  await client.execute("UPDATE advisor_profit_trial_state SET payload = '{}'");
  await expect(repository.readState(policy.id)).rejects.toThrow('integrity');
});

test('a read-only report and active selection never advance trial accounts', async () => {
  const before = await repository.readState(policy.id);
  clock += 100000;
  await service.getReport(policy.id);
  await service.getActivePolicy(policy);
  expect(await repository.readState(policy.id)).toEqual(before);
});

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

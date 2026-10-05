/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createTradingAdvisorService } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { getAdvisorDecisionPortfolio } from '@/services/research/tradingAdvisor/advisorPortfolio.utils';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { getTradingAdvice } from '../utils/tradingAdvisor.utils';
import { createAdvisorPlan, getAdvisorPlanState } from '../utils/advisorPlan.utils';
import { START, contract, bookAt, forecastAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
const policy = createTradingAdvisorPolicy({ runId: 'plan-storage' });
let client;
let repository;
let clock;
let lease;
beforeEach(async () => {
  clock = START + 60000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  await repository.ensurePolicy(policy, START);
  lease = await repository.acquireLease(policy.id, 'plan-test');
  await repository.writeHeartbeat(
    { policyId: policy.id, status: 'running', heartbeatAt: clock },
    lease,
  );
});
afterEach(() => client.close());

async function saveAdvice({
  probability = 0.85,
  book = bookAt(clock),
  validFor = policy.cadenceMs,
} = {}) {
  await repository.writeHeartbeat(
    { policyId: policy.id, status: 'running', heartbeatAt: clock },
    lease,
  );
  const state = await repository.readState(policy.id);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock, probability);
  const portfolio = getAdvisorDecisionPortfolio({
    account: state.account,
    book,
    now: clock,
    policy,
    riskHistory: state.risk?.history ?? null,
  });
  const advice = {
    ...getTradingAdvice({ contract, forecast, book, portfolio, now: clock, policy }),
    id: `${policy.id}:${contract.ticker}:${clock}`,
    forecast,
    book,
    portfolio,
    accountVersion: state.account.version,
    validUntil: Math.min(clock + validFor, contract.expiresAt),
  };
  await repository.saveAdvice({ advice, researchInputSnapshot, lease });
  return { advice, researchInputSnapshot };
}
async function fill(advice) {
  clock = advice.evaluatedAt + policy.minimumFillDelayMs;
  await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease });
  return repository.saveExecution({
    adviceId: advice.id,
    book: bookAt(clock),
    recordedAt: clock,
    observationAttemptToken: lease.token,
    lease,
  });
}
const report = () =>
  createTradingAdvisorService({ repository, policy, now: () => clock }).getReport();
const display = async () =>
  getAdvisorPlanState({ report: await report(), market: contract, now: clock });

test('a persisted plan survives repository restart with the post-save account version', async () => {
  const { advice } = await saveAdvice();
  const state = await repository.readState(policy.id);
  expect(state.currentPlan).toMatchObject({
    adviceId: advice.id,
    action: 'buy',
    assessedAt: advice.evaluatedAt,
    validUntil: advice.validUntil,
    accountVersion: state.account.version,
  });
  expect(state.currentPlan.accountVersion).toBe(advice.accountVersion + 1);
  expect(state.currentPlan.advice.book).toBeUndefined();
  expect(state.currentPlan.advice.forecast).toBeUndefined();
  const restarted = createTradingAdvisorRepository({ client, now: () => clock });
  expect((await restarted.readState(policy.id)).currentPlan).toEqual(state.currentPlan);
  expect((await report()).currentPlan).toEqual(state.currentPlan);
  expect((await display()).heading).toBe('BUY UP');
  expect((await display()).readiness).toBe('pending');
});

test('plan persistence leaves exact incumbent numerical validation and append-only advice intact', async () => {
  const { advice, researchInputSnapshot } = await saveAdvice();
  const saved = await repository.readAdvice(advice.id);
  expect(saved).toEqual(advice);
  const replay = getTradingAdvice({
    contract,
    forecast: saved.forecast,
    book: saved.book,
    portfolio: saved.portfolio,
    now: saved.evaluatedAt,
    policy,
  });
  for (const [key, value] of Object.entries(replay)) expect(saved[key]).toEqual(value);
  const before = await repository.readState(policy.id);
  await repository.saveAdvice({ advice, researchInputSnapshot, lease });
  expect((await repository.readState(policy.id)).account).toEqual(before.account);
  expect((await repository.readState(policy.id)).currentPlan).toEqual(before.currentPlan);
  await expect(
    repository.saveAdvice({
      advice: { ...advice, probability: 0.99 },
      researchInputSnapshot,
      lease,
    }),
  ).rejects.toThrow('cannot be replaced');
  expect((await repository.readState(policy.id)).currentPlan).toEqual(before.currentPlan);
});

test('a recorded fill consumes BUY until a new position assessment, including after restart', async () => {
  const { advice } = await saveAdvice();
  await fill(advice);
  const state = await repository.readState(policy.id);
  expect(state.account.positions).toHaveLength(1);
  expect(state.currentPlan.accountVersion).toBeLessThan(state.account.version);
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  let current = await display();
  expect(current.current).toBeNull();
  expect(current.historical.adviceId).toBe(advice.id);
  expect(current.heading).toBe('UP PURCHASED');
  expect(current.readiness).toBe('filled');
  clock = advice.evaluatedAt + policy.cadenceMs;
  const hold = (await saveAdvice()).advice;
  expect(hold.action).toBe('hold');
  current = await display();
  expect(current.current.adviceId).toBe(hold.id);
  expect(current.heading).toBe('HOLD UP');
  expect(current.readiness).toBe('ready');
  expect((await repository.readState(policy.id)).account.positions).toHaveLength(1);
});

test('a new proposal cannot change the incumbent quantity while retaining valid saved inputs', async () => {
  const state = await repository.readState(policy.id);
  const book = bookAt(clock);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock);
  const portfolio = getAdvisorDecisionPortfolio({
    account: state.account,
    book,
    now: clock,
    policy,
    riskHistory: null,
  });
  const expected = getTradingAdvice({ contract, forecast, book, portfolio, now: clock, policy });
  expect(expected.action).toBe('buy');
  await expect(
    repository.saveAdvice({
      advice: {
        ...expected,
        id: 'altered-quantity',
        quantity: expected.quantity + 1,
        forecast,
        book,
        portfolio,
        accountVersion: state.account.version,
        validUntil: clock + policy.cadenceMs,
      },
      researchInputSnapshot,
      lease,
    }),
  ).rejects.toThrow('does not match the available account and saved inputs');
  const unchanged = await repository.readState(policy.id);
  expect(unchanged.account).toEqual(state.account);
  expect(unchanged.currentPlan).toBeNull();
  expect(unchanged.advice).toHaveLength(0);
});

test('a missing quote after a fill never restores the consumed BUY', async () => {
  const { advice } = await saveAdvice({ validFor: 30000 });
  await fill(advice);
  clock = advice.evaluatedAt + policy.cadenceMs;
  const waiting = (await saveAdvice({ book: null })).advice;
  expect(waiting.action).toBe('wait');
  const state = await repository.readState(policy.id);
  expect(state.currentPlan.adviceId).toBe(advice.id);
  expect(state.currentPlan.action).toBe('buy');
  expect(state.currentPlan.accountVersion).toBe(advice.accountVersion + 1);
  expect(state.currentPlan.accountVersion).toBeLessThan(state.account.version);
  expect((await display()).current).toBeNull();
  expect((await display()).heading).toBe('UP PURCHASED');
  expect((await display()).readiness).toBe('filled');
});

test('an unchanged HOLD survives operational waiting without extending its original expiry', async () => {
  const { advice } = await saveAdvice();
  await fill(advice);
  clock = advice.evaluatedAt + policy.cadenceMs;
  const hold = (await saveAdvice({ validFor: 30000 })).advice;
  expect(hold.action).toBe('hold');
  const original = (await repository.readState(policy.id)).currentPlan;
  clock += policy.cadenceMs;
  const waiting = (await saveAdvice({ book: null })).advice;
  expect(waiting.action).toBe('wait');
  const state = await repository.readState(policy.id);
  expect(state.currentPlan).toMatchObject({
    adviceId: hold.id,
    assessedAt: original.assessedAt,
    validUntil: original.validUntil,
    accountVersion: original.accountVersion,
  });
  expect((await display()).heading).toBe('HOLD UP');
  expect((await display()).active.adviceId).toBe(hold.id);
  clock = original.validUntil;
  expect((await display()).current).toBeNull();
  expect((await display()).active.adviceId).toBe(hold.id);
  expect((await display()).historical).toBeNull();
  expect((await display()).heading).toBe('HOLD UP');
  expect((await display()).readiness).toBe('stale');
});

test('recovers overwritten assessments from append-only advice without authorizing old orders', async () => {
  const { advice } = await saveAdvice();
  await fill(advice);
  clock = advice.evaluatedAt + policy.cadenceMs;
  const waiting = (await saveAdvice({ book: null })).advice;
  const payload = JSON.stringify(createAdvisorPlan(waiting));
  await client.execute({
    sql: 'UPDATE advisor_current_plans SET payload = ?, content_hash = ? WHERE policy_id = ?',
    args: [payload, createHash('sha256').update(payload).digest('hex'), policy.id],
  });
  const before = (await repository.readState(policy.id)).account;
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  const recovered = await repository.readState(policy.id);
  expect(recovered.currentPlan).toMatchObject({
    adviceId: advice.id,
    assessedAt: advice.evaluatedAt,
    historicalOnly: true,
  });
  expect(recovered.account).toEqual(before);
  expect((await display()).heading).toBe('UP PURCHASED');
  expect((await display()).current).toBeNull();
  clock += policy.cadenceMs;
  await saveAdvice({ book: null });
  expect((await repository.readState(policy.id)).currentPlan).toEqual(recovered.currentPlan);
});

test('configuration rollover retains the old assessment without changing its policy or evidence', async () => {
  const { advice } = await saveAdvice({ probability: 0.5 });
  expect(advice.action).toBe('wait');
  expect(advice.reason).toBe('insufficient_entry_edge');
  const original = (await repository.readState(policy.id)).currentPlan;
  const payload = JSON.stringify({ revision: 1, policy, configuredAt: START });
  await client.execute({
    sql: 'INSERT INTO advisor_configuration(id, payload, content_hash) VALUES (1, ?, ?)',
    args: [payload, createHash('sha256').update(payload).digest('hex')],
  });
  await repository.writeHeartbeat(
    { policyId: policy.id, status: 'stopped', heartbeatAt: clock },
    lease,
  );
  await repository.releaseLease(lease);
  const configuration = await repository.configure({
    allocation: 100,
    riskLevel: 'balanced',
    expectedRevision: 1,
  });
  const state = await repository.readState(configuration.policy.id);
  expect(state.currentPlan).toEqual(original);
  expect(state.currentPlan.policyId).toBe(policy.id);
  const stateForDisplay = getAdvisorPlanState({
    report: {
      startedAt: clock,
      policy: configuration.policy,
      collector: { status: 'running', heartbeatAt: clock },
      portfolio: { accountVersion: original.accountVersion },
      currentPlan: state.currentPlan,
    },
    market: contract,
    now: clock,
  });
  expect(stateForDisplay.heading).toBe('REVIEWING ACCOUNT');
  expect(stateForDisplay.current).toBeNull();
  expect(state.account.cash).toBe(100);
});

test('plan write failure atomically rolls back advice, cash reservation and valuation', async () => {
  await client.execute(`CREATE TRIGGER fail_test_plan BEFORE INSERT ON advisor_current_plans
    BEGIN SELECT RAISE(ABORT, 'test plan failure'); END`);
  await expect(saveAdvice()).rejects.toThrow('test plan failure');
  const state = await repository.readState(policy.id);
  expect(state.currentPlan).toBeNull();
  expect(state.advice).toHaveLength(0);
  expect(state.account.cash).toBe(100);
  expect(state.account.pendingIntents).toHaveLength(0);
  expect(state.risk).toBeNull();
});

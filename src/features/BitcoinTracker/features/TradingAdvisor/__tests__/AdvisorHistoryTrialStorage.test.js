/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createAdvisorHistoryTrialRepository } from '@/services/research/tradingAdvisor/advisorHistoryTrials.repository';
import {
  getAdvisorLanguageModelConfiguration,
  getAdvisorLanguageModelPublicConfiguration,
  ADVISOR_LANGUAGE_MODEL_PRICING,
  ADVISOR_LANGUAGE_MODEL_PRICING_VERSION,
  createAdvisorLanguageModelProvider,
} from '@/services/research/tradingAdvisor/advisorLanguageModel.service';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
let client;
let repository;
let clock;
const policy = createTradingAdvisorPolicy({
  allocation: 50,
  riskLevel: 'balanced',
  runId: 'history-storage',
});
const provider = getAdvisorLanguageModelPublicConfiguration(
  getAdvisorLanguageModelConfiguration({}),
);
const reservation = (id = 'request-1', extra = {}) => ({
  requestId: id,
  requestedAt: clock,
  reservationExpiresAt: clock + 15000,
  maximumCostUsd: 0.03,
  maximumDailySpendUsd: 1,
  minimumRequestIntervalMs: 30000,
  model: 'gpt-6.1-sol',
  promptVersion: 'paper-advisor-history-v1',
  pricingVersion: ADVISOR_LANGUAGE_MODEL_PRICING_VERSION,
  inputUsdPerMillionTokens: ADVISOR_LANGUAGE_MODEL_PRICING.inputUsdPerMillionTokens,
  outputUsdPerMillionTokens: ADVISOR_LANGUAGE_MODEL_PRICING.outputUsdPerMillionTokens,
  maximumInputTokens: 10000,
  maximumOutputTokens: 1000,
  ...extra,
});
const completion = (id = 'request-1', extra = {}) => ({
  reservationId: id,
  requestId: id,
  requestStarted: true,
  status: 'completed',
  completedAt: clock,
  inputTokens: 1000,
  outputTokens: 300,
  costUsd: 0.005,
  model: 'gpt-6.1-sol',
  responseId: 'resp_test',
  ...extra,
});
const observation = (id, extra = {}) => ({
  id,
  kind: 'observation',
  contract,
  forecast: forecastAt(clock),
  book: bookAt(clock),
  observedAt: clock,
  ...extra,
});
async function storedReservation(id = 'request-1') {
  return (
    await client.execute({ sql: 'SELECT * FROM advisor_ai_reservations WHERE id = ?', args: [id] })
  ).rows[0];
}

beforeEach(() => {
  clock = START - 1000;
  client = createClient({ url: 'file::memory:' });
  repository = createAdvisorHistoryTrialRepository({ client, now: () => clock });
});
afterEach(() => client.close());

test('durably reserves worst-case spend and permits only one in-flight request across repository instances', async () => {
  const other = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  const results = await Promise.all([
    repository.reserveBudget(reservation()),
    other.reserveBudget(reservation('request-2')),
  ]);
  expect(results.filter((result) => result.accepted)).toHaveLength(1);
  expect(results.find((result) => !result.accepted).reason).toBe('busy');
  const rows = (await client.execute('SELECT * FROM advisor_ai_reservations')).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].charged_cost).toBe(0.03);
  expect(rows[0].status).toBe('pending');
  expect(JSON.parse(rows[0].payload).maximumInputTokens).toBe(10000);
});

test('expired or abandoned requests release concurrency while retaining unknown spend', async () => {
  await repository.reserveBudget(reservation());
  clock += 31000;
  const restarted = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  expect(await restarted.reserveBudget(reservation('request-2'))).toMatchObject({ accepted: true });
  expect((await storedReservation()).charged_cost).toBe(0.03);
  expect(
    (await client.execute('SELECT SUM(charged_cost) AS total FROM advisor_ai_reservations')).rows[0]
      .total,
  ).toBeCloseTo(0.06, 8);
});

test('enforces daily spend before reserving and resets the accounting day without erasing prior charges', async () => {
  await repository.reserveBudget(reservation('request-1', { maximumDailySpendUsd: 0.05 }));
  clock += 31000;
  expect(
    await repository.reserveBudget(reservation('request-2', { maximumDailySpendUsd: 0.05 })),
  ).toMatchObject({ accepted: false, reason: 'daily_budget_exhausted' });
  expect((await client.execute('SELECT id FROM advisor_ai_reservations')).rows).toHaveLength(1);
  clock = Date.UTC(2026, 9, 4, 0, 1);
  expect(
    await repository.reserveBudget(reservation('next-day', { maximumDailySpendUsd: 0.05 })),
  ).toMatchObject({ accepted: true });
  expect((await storedReservation()).charged_cost).toBe(0.03);
});

test('reconciles only exact priced token usage and rejects a second changed completion', async () => {
  await repository.reserveBudget(reservation());
  clock += 1000;
  const completed = completion();
  await repository.completeReservation(completed);
  expect((await storedReservation()).charged_cost).toBe(0.005);
  expect((await storedReservation()).status).toBe('completed');
  await repository.completeReservation(completed);
  expect((await client.execute('SELECT id FROM advisor_ai_completions')).rows).toHaveLength(1);
  await expect(repository.completeReservation({ ...completed, costUsd: 0 })).rejects.toThrow(
    'cannot change',
  );
  await expect(client.execute('DELETE FROM advisor_ai_completions')).rejects.toThrow('append-only');
  expect(await repository.reserveBudget(reservation())).toMatchObject({
    accepted: false,
    reason: 'duplicate_request',
  });
});

test('rate limiting survives completion and restart', async () => {
  await repository.reserveBudget(reservation());
  clock += 1000;
  await repository.completeReservation(completion());
  const restarted = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  expect(await restarted.reserveBudget(reservation('request-2'))).toMatchObject({
    accepted: false,
    reason: 'rate_limited',
  });
  clock += 29000;
  expect(await restarted.reserveBudget(reservation('request-2'))).toMatchObject({ accepted: true });
});

test('unknown costs after timeout retain the maximum reservation; cancellation before sending can cost zero', async () => {
  await repository.reserveBudget(reservation());
  clock += 1000;
  await expect(
    repository.completeReservation(
      completion('request-1', {
        status: 'timeout',
        inputTokens: null,
        outputTokens: null,
        costUsd: 0,
      }),
    ),
  ).rejects.toThrow('full reservation');
  await repository.completeReservation(
    completion('request-1', {
      status: 'timeout',
      inputTokens: null,
      outputTokens: null,
      costUsd: 0.03,
    }),
  );
  expect((await storedReservation()).charged_cost).toBe(0.03);
  clock += 30000;
  await repository.reserveBudget(reservation('never-sent'));
  await repository.completeReservation(
    completion('never-sent', {
      status: 'canceled',
      requestStarted: false,
      inputTokens: null,
      outputTokens: null,
      costUsd: 0,
      model: null,
      responseId: null,
    }),
  );
  expect((await storedReservation('never-sent')).charged_cost).toBe(0);
});

test.each([
  { requestId: 'another-request' },
  { costUsd: -1 },
  { costUsd: 0 },
  { completedAt: START + 60000 },
  { inputTokens: 1.5 },
  { inputTokens: 0 },
  { outputTokens: 1001 },
  { inputTokens: null },
  { status: 'invented' },
  { requestStarted: false },
])('rejects inconsistent completions and leaves reserved spend intact: %j', async (patch) => {
  await repository.reserveBudget(reservation());
  await expect(repository.completeReservation(completion('request-1', patch))).rejects.toThrow();
  expect((await storedReservation()).charged_cost).toBe(0.03);
  expect((await client.execute('SELECT id FROM advisor_ai_completions')).rows).toHaveLength(0);
});

test.each([
  { requestedAt: START + 10000 },
  { reservationExpiresAt: START - 2000 },
  { maximumCostUsd: 0.001 },
  { inputUsdPerMillionTokens: 0 },
  { pricingVersion: 'invented' },
  { model: 'unpriced-model' },
  { maximumOutputTokens: 99999 },
  { minimumRequestIntervalMs: 1 },
])('rejects expired, unpriced or understated reservations: %j', async (patch) => {
  expect((await repository.reserveBudget(reservation('request-1', patch))).accepted).toBe(false);
  expect((await client.execute('SELECT id FROM advisor_ai_reservations')).rows).toHaveLength(0);
});

test('trial registration freezes policy and provider before an asynchronous write and starts new versions separately', async () => {
  const mutablePolicy = { ...policy };
  const mutableProvider = { ...provider };
  const operation = repository.ensureTrial(mutablePolicy, mutableProvider, clock);
  mutablePolicy.initialBankroll = 1;
  mutableProvider.enabled = true;
  const first = await operation;
  expect(first.policy).toEqual(policy);
  expect(first.provider).toEqual(provider);
  clock += 1000;
  const restarted = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  expect((await restarted.ensureTrial(policy, provider, clock)).registeredAt).toBe(START - 1000);
  const changed = await restarted.ensureTrial(
    policy,
    { ...provider, promptVersion: 'new-prompt' },
    clock,
  );
  expect(changed.id).not.toBe(first.id);
  expect(changed.contracts).toHaveLength(0);
  expect((await restarted.readState(first.id)).registeredAt).toBe(START - 1000);
});

test('captures immutable prospective observations, preserves no-fill outcomes and retains unresolved cohort members', async () => {
  const trial = await repository.ensureTrial(policy, provider, clock);
  clock = START + 60000;
  const input = observation('first');
  const enrolled = await repository.record(trial.id, input);
  expect(enrolled.contracts).toHaveLength(1);
  expect(enrolled.strategies.incumbent.account.pendingIntents).toHaveLength(1);
  await repository.record(trial.id, input);
  expect((await client.execute('SELECT id FROM advisor_history_observations')).rows).toHaveLength(
    1,
  );
  await expect(
    repository.record(trial.id, { ...input, forecast: forecastAt(clock, 0.2) }),
  ).rejects.toThrow('cannot change');
  clock += 16000;
  const noFill = await repository.record(
    trial.id,
    observation('expired', { forecast: null, book: null }),
  );
  expect(noFill.strategies.incumbent.account.cash).toBe(50);
  expect(noFill.contracts[0].outcome).toBeNull();
  clock = contract.expiresAt;
  const settled = await repository.record(trial.id, {
    id: 'settled',
    kind: 'settlement',
    market: outcomeAt(clock),
    observedAt: clock,
  });
  expect(settled.contracts[0].outcome.result).toBe('yes');
  expect(settled.contracts[0].scores.incumbent.netProfit).toBe(0);
  await expect(
    repository.record(trial.id, {
      id: 'conflicting-outcome',
      kind: 'settlement',
      market: outcomeAt(clock, 'no'),
      observedAt: clock,
    }),
  ).rejects.toThrow('cannot change');
  await expect(client.execute('DELETE FROM advisor_history_observations')).rejects.toThrow(
    'append-only',
  );
});

test('never enrolls a contract already running at registration and rejects future or backwards captures', async () => {
  clock = START + 60000;
  const trial = await repository.ensureTrial(policy, provider, clock);
  const state = await repository.record(trial.id, observation('current'));
  expect(state.contracts).toHaveLength(0);
  await expect(
    repository.record(trial.id, observation('future', { observedAt: clock + 1 })),
  ).rejects.toThrow('future');
  await expect(
    repository.record(trial.id, observation('past', { observedAt: START })),
  ).rejects.toThrow('chronological');
  await expect(repository.ensureTrial(policy, provider, clock + 1)).rejects.toThrow('prospective');
});

test('reports independent accounts without advancing them and detects corrupted persisted state', async () => {
  const trial = await repository.ensureTrial(policy, provider, clock);
  const before = await repository.readState(trial.id);
  expect((await repository.getReport(policy.id)).strategies).toHaveLength(3);
  expect(await repository.readState(trial.id)).toEqual(before);
  await client.execute({
    sql: 'UPDATE advisor_history_state SET payload = ? WHERE id = ?',
    args: ['{}', trial.id],
  });
  await expect(repository.readState(trial.id)).rejects.toThrow('integrity');
});

test('the real provider adapter reconciles both known and unknown costs through the durable ledger', async () => {
  const configuration = getAdvisorLanguageModelConfiguration({
    ADVISOR_LLM_ENABLED: 'true',
    ADVISOR_LLM_MODEL: 'gpt-6.1-sol',
    OPENAI_API_KEY: 'mock-key-never-sent',
    ADVISOR_LLM_MIN_REQUEST_INTERVAL_MS: '30000',
  });
  const decision = {
    action: 'HOLD',
    optionId: 'hold',
    snapshotId: 'snapshot-test',
    evidenceRefs: ['account'],
    rationale: 'The evidence still supports the existing plan.',
    thesis: 'The original reason for entry remains supported.',
    invalidationConditions: ['Sustained deterioration in the observed evidence.'],
    reviewHorizon: '15s',
  };
  const fetchImpl = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_test',
          model: 'gpt-6.1-sol',
          status: 'completed',
          usage: { input_tokens: 1000, output_tokens: 300 },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(decision) }],
            },
          ],
        }),
        { status: 200 },
      ),
  );
  const adapter = createAdvisorLanguageModelProvider({
    configuration,
    now: () => clock,
    fetchImpl,
    reserveBudget: repository.reserveBudget,
    completeReservation: repository.completeReservation,
  });
  const evidence = () => ({
    snapshotId: 'snapshot-test',
    observedAt: clock,
    expiresAt: clock + 15000,
  });
  const first = await adapter.invoke({ evidence: evidence(), requestId: 'real-contract-1' });
  expect(first.status).toBe('completed');
  expect((await storedReservation('real-contract-1')).charged_cost).toBe(0.005);
  clock += 30000;
  fetchImpl.mockRejectedValue(new Error('unavailable'));
  const second = await adapter.invoke({ evidence: evidence(), requestId: 'real-contract-2' });
  expect(second.status).toBe('provider_error');
  const stored = await storedReservation('real-contract-2');
  expect(stored.charged_cost).toBe(stored.maximum_cost);
  expect(stored.status).toBe('completed');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

async function pendingLanguageRequest() {
  const enabled = getAdvisorLanguageModelPublicConfiguration(
    getAdvisorLanguageModelConfiguration({
      ADVISOR_LLM_ENABLED: 'true',
      ADVISOR_LLM_MODEL: 'gpt-6.1-sol',
      OPENAI_API_KEY: 'mock-key',
    }),
  );
  const state = await repository.ensureTrial(policy, enabled, clock);
  clock = START + 60000;
  const captured = await repository.record(state.id, observation('source'));
  return { trialId: state.id, request: captured.strategies['language-model'].pendingRequest };
}

test('an AI response must match the exact evidence and request archived before inference', async () => {
  const { trialId, request } = await pendingLanguageRequest();
  expect(request).not.toBeNull();
  const row = (
    await client.execute({
      sql: 'SELECT payload FROM advisor_history_observations WHERE id = ?',
      args: [request.evidence.snapshotId],
    })
  ).rows[0];
  expect(JSON.parse(row.payload).languageModelRequest.evidence).toEqual(request.evidence);
  clock += 1000;
  const captured = {
    id: 'returned',
    kind: 'response',
    requestId: request.requestId,
    evidence: request.evidence,
    observedAt: clock,
    result: {
      status: 'provider_error',
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      respondedAt: clock,
      inferenceCostUsd: 0.03,
      output: null,
    },
  };
  await expect(
    repository.record(trialId, {
      ...captured,
      evidence: { ...request.evidence, accountVersion: request.evidence.accountVersion + 1 },
    }),
  ).rejects.toThrow('immutable captured request');
  await expect(
    repository.record(trialId, { ...captured, requestId: 'forged-request' }),
  ).rejects.toThrow('immutable captured request');
  await expect(
    repository.record(trialId, {
      ...captured,
      evidence: { ...request.evidence, snapshotId: `${trialId}:never-recorded` },
    }),
  ).rejects.toThrow('immutable captured request');
  await expect(
    repository.record(trialId, {
      ...captured,
      result: { ...captured.result, respondedAt: clock + 1 },
    }),
  ).rejects.toThrow('response time');
  const accepted = await repository.record(trialId, captured);
  expect(accepted.strategies['language-model'].pendingRequest.result.status).toBe('provider_error');
  expect(accepted.strategies['language-model'].inferenceCost).toBe(0.03);
  expect(await repository.record(trialId, captured)).toEqual(accepted);
});

test('unarchived inference charges survive restart and reduce reported profit conservatively', async () => {
  const { trialId, request } = await pendingLanguageRequest();
  await repository.reserveBudget(reservation(request.requestId));
  clock += 16000;
  repository = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  const report = await repository.getReport(policy.id);
  const language = report.strategies.find((strategy) => strategy.id === 'language-model');
  expect(report.costDiscrepancy).toBe(true);
  expect(report.unresolvedCostReservations).toBe(1);
  expect(language.inferenceCost).toBe(0.03);
  expect(language.recordedInferenceCost).toBe(0);
  expect(language.netProfit).toBe(-0.03);
  expect(language.readyForReview).toBe(false);
  expect((await repository.readState(trialId)).strategies['language-model'].inferenceCost).toBe(0);
});

test('known durable charges reconcile with their archived response and clear the accounting gap', async () => {
  const { trialId, request } = await pendingLanguageRequest();
  await repository.reserveBudget(reservation(request.requestId));
  clock += 1000;
  await repository.completeReservation(completion(request.requestId));
  expect((await repository.getReport(policy.id)).costDiscrepancy).toBe(true);
  await repository.record(trialId, {
    id: 'response',
    kind: 'response',
    requestId: request.requestId,
    evidence: request.evidence,
    observedAt: clock,
    result: {
      status: 'invalid_response',
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      respondedAt: clock,
      inferenceCostUsd: 0.005,
      output: null,
    },
  });
  const report = await repository.getReport(policy.id);
  expect(report.costDiscrepancy).toBe(false);
  expect(report.unresolvedCostReservations).toBe(0);
  expect(report.strategies.find((strategy) => strategy.id === 'language-model').netProfit).toBe(
    -0.005,
  );
});

async function createPendingOrders() {
  const trial = await repository.ensureTrial(policy, provider, clock);
  clock = START + 60000;
  await repository.record(trial.id, observation('first-observation'));
  clock += 15001;
  await repository.record(trial.id, observation('second-observation'));
  clock += 15001;
  const state = await repository.record(trial.id, observation('entry'));
  expect(state.strategies.incumbent.account.pendingIntents).toHaveLength(1);
  expect(state.strategies['history-rules'].account.pendingIntents).toHaveLength(1);
  return { ...trial, decisionAt: clock };
}

test('one delayed book claim covers all eligible accounts and competing workers cannot claim them again', async () => {
  const trial = await createPendingOrders();
  clock += policy.minimumFillDelayMs;
  const other = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  const claims = await Promise.all([
    repository.claimExecutionObservation(trial.id, clock),
    other.claimExecutionObservation(trial.id, clock),
  ]);
  const claim = claims.find(Boolean);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claim).toMatchObject({
    contract,
    requestedAt: clock,
    deadline: trial.decisionAt + policy.maximumFillDelayMs + 1,
  });
  expect(claim.sourceId).toMatch(/^shadow-execution:[a-f0-9]{32}$/);
  const rows = (await client.execute('SELECT * FROM advisor_history_execution_requests')).rows;
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => JSON.parse(row.payload).sourceId)).size).toBe(1);
  expect(rows.every((row) => row.requested_at === clock)).toBe(true);
  const restarted = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  expect(await restarted.claimExecutionObservation(trial.id, clock)).toBeNull();
  await expect(client.execute('DELETE FROM advisor_history_execution_requests')).rejects.toThrow(
    'append-only',
  );
});

test('execution observation claims never start before the delay, after expiry, or with a future timestamp', async () => {
  const trial = await createPendingOrders();
  expect(await repository.claimExecutionObservation(trial.id, clock)).toBeNull();
  await expect(repository.claimExecutionObservation(trial.id, clock + 1)).rejects.toThrow(
    'capture time',
  );
  clock += policy.maximumFillDelayMs + 1;
  expect(await repository.claimExecutionObservation(trial.id, clock)).toBeNull();
  expect(
    (await client.execute('SELECT id FROM advisor_history_execution_requests')).rows,
  ).toHaveLength(0);
});

test('a crashed claimed observation does not obtain a replacement and its reservation can expire as no-fill', async () => {
  const trial = await createPendingOrders();
  clock += policy.minimumFillDelayMs;
  expect(await repository.claimExecutionObservation(trial.id, clock)).not.toBeNull();
  clock += 1000;
  const restarted = createAdvisorHistoryTrialRepository({ client, now: () => clock });
  expect(await restarted.claimExecutionObservation(trial.id, clock)).toBeNull();
  const unrelated = await restarted.record(
    trial.id,
    observation('ordinary-quote', {
      sourceId: 'unrelated-main-adviser-quote',
      forecast: null,
    }),
  );
  expect(unrelated.strategies.incumbent.account.positions).toHaveLength(0);
  expect(unrelated.strategies.incumbent.account.pendingIntents).toHaveLength(1);
  expect(unrelated.strategies.incumbent.account.cash).toBeLessThan(50);
  clock = trial.decisionAt + policy.maximumFillDelayMs + 1;
  const state = await restarted.record(
    trial.id,
    observation('expiry', { book: null, forecast: null }),
  );
  expect(state.strategies.incumbent.account.pendingIntents).toHaveLength(0);
  expect(state.strategies.incumbent.account.cash).toBe(50);
  expect(state.strategies.incumbent.account.positions).toHaveLength(0);
  expect(await restarted.claimExecutionObservation(trial.id, clock)).toBeNull();
});

test('a shared claim accepts exactly its observed book and a missing claimed book cancels without retry', async () => {
  const trial = await createPendingOrders();
  clock += policy.minimumFillDelayMs;
  const claim = await repository.claimExecutionObservation(trial.id, clock);
  const captured = observation('claimed-fill', { sourceId: claim.sourceId, forecast: null });
  const filled = await repository.record(trial.id, captured);
  expect(filled.strategies.incumbent.account.positions).toHaveLength(1);
  expect(filled.strategies['history-rules'].account.positions).toHaveLength(1);
  expect(filled.strategies.incumbent.account.pendingIntents).toHaveLength(0);
  expect(await repository.record(trial.id, captured)).toEqual(filled);
});

test('a failed claimed book releases reserved cash immediately and cannot later fill from a favorable quote', async () => {
  const trial = await createPendingOrders();
  clock += policy.minimumFillDelayMs;
  const claim = await repository.claimExecutionObservation(trial.id, clock);
  const canceled = await repository.record(
    trial.id,
    observation('claimed-failure', {
      sourceId: claim.sourceId,
      forecast: null,
      book: null,
    }),
  );
  expect(canceled.strategies.incumbent.account.pendingIntents).toHaveLength(0);
  expect(canceled.strategies.incumbent.account.cash).toBe(50);
  clock += 1000;
  const later = await repository.record(trial.id, observation('later-book', { forecast: null }));
  expect(later.strategies.incumbent.account.positions).toHaveLength(0);
  expect(later.strategies.incumbent.account.cash).toBe(50);
});

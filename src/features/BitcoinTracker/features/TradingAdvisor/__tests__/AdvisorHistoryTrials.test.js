/** @jest-environment node */
import {
  advanceAdvisorHistoryTrial,
  createAdvisorHistoryTrial,
  getAdvisorHistoryTrialReport,
  recordAdvisorLanguageModelResult,
} from '@/services/research/tradingAdvisor/advisorHistoryTrials.utils';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { getAdvisorPlanState } from '../utils/advisorPlan.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

const NOW = START + 60000;
const policy = createTradingAdvisorPolicy({ runId: 'history-trial-test' });
const provider = {
  enabled: true,
  model: 'mock-model',
  promptVersion: 'test-prompt-v1',
  minimumRequestIntervalMs: 30000,
};
const trial = () =>
  createAdvisorHistoryTrial({ id: 'trial-test', policy, provider, registeredAt: START });
const observation = (at = NOW, withForecast = true, book = bookAt(at)) => ({
  id: `observation-${at}`,
  kind: 'observation',
  contract,
  observedAt: at,
  book,
  ...(withForecast ? { forecast: forecastAt(at, 0.85) } : {}),
});
const request = (state) => state.strategies['language-model'].pendingRequest;
const guidanceFor = (state) =>
  getAdvisorHistoryTrialReport(state).strategies.find(
    (strategy) => strategy.id === 'language-model',
  ).guidance;
function resultFor(state, action = 'BUY_YES') {
  const pending = request(state);
  const evidence = pending.evidence;
  const option = evidence.options.find((row) => row.action === action);
  return {
    status: 'completed',
    model: 'mock-model',
    respondedAt: pending.requestedAt + 4000,
    inferenceCostUsd: 0.003,
    output: {
      action,
      optionId: option.id,
      snapshotId: evidence.snapshotId,
      evidenceRefs: [evidence.points.at(-1).id, evidence.account.id],
      rationale: 'The current opportunity supports this paper trade after costs.',
      thesis: 'Maintain the position only while probability and executable value support it.',
      invalidationConditions: ['Fresh evidence materially weakens the opportunity.'],
      reviewHorizon: '15s',
    },
  };
}

test('starts equal-capital independent accounts and preserves incumbent entry behavior', () => {
  const state = advanceAdvisorHistoryTrial(trial(), observation());
  const incumbent = state.strategies.incumbent;
  const rules = state.strategies['history-rules'];
  const language = state.strategies['language-model'];
  expect(incumbent.account.pendingIntents[0].action).toBe('buy');
  expect(rules.latestDecision.action).toBe('NO_TRADE');
  expect(rules.account.cash).toBe(100);
  expect(language.account.cash).toBe(100);
  expect(language.pendingRequest.evidence.available).toBe(true);
  expect(state.rules.automaticPromotion).toBe(false);
});

test('rules entry requires a prospective history and consumes a later partial book exactly once', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 2000, false));
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 15000));
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 30000));
  const intent = state.strategies['history-rules'].account.pendingIntents[0];
  expect(intent).toMatchObject({ action: 'buy', candidatePolicyVersion: 'history-rules-v1' });
  const at = NOW + 32000;
  const book = { ...bookAt(at), yesAsks: [{ price: 0.5, quantity: 3 }] };
  state = advanceAdvisorHistoryTrial(state, observation(at, false, book));
  const account = state.strategies['history-rules'].account;
  expect(account.positions[0].quantity).toBe(3);
  expect(account.pendingIntents).toHaveLength(0);
  const cash = account.cash;
  state = advanceAdvisorHistoryTrial(state, observation(at + 1, false, book));
  expect(state.strategies['history-rules'].account.cash).toBe(cash);
  expect(state.strategies['history-rules'].account.positions[0].quantity).toBe(3);
});

test('records the AI proposal, accepts on a later fresh snapshot and fills only after acceptance delay', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const result = resultFor(state);
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result,
    observedAt: NOW + 4000,
  });
  expect(state.strategies['language-model'].latestDecision.status).toBe('proposed');
  state = JSON.parse(JSON.stringify(state));
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  const strategy = state.strategies['language-model'];
  expect(strategy.latestDecision.status).toBe('accepted');
  expect(strategy.plan).toMatchObject({ action: 'BUY_YES', assessedAt: NOW + 5000 });
  expect(strategy.account.positions).toHaveLength(0);
  expect(strategy.account.pendingIntents[0].evaluatedAt).toBe(NOW + 5000);
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 6000, false));
  expect(state.strategies['language-model'].account.positions).toHaveLength(0);
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 7000, false));
  expect(state.strategies['language-model'].account.positions).toHaveLength(1);
  expect(state.strategies['language-model'].account.pendingIntents).toHaveLength(0);
  expect(state.strategies['language-model'].inferenceCost).toBe(0.003);
});

test('a false evidence reference is journaled as vetoed and falls back at the current time', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const result = resultFor(state);
  result.output.evidenceRefs = ['made-up-reference'];
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result,
    observedAt: NOW + 4000,
  });
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  const strategy = state.strategies['language-model'];
  expect(strategy.decisions.some((decision) => decision.status === 'proposed')).toBe(true);
  expect(
    strategy.decisions.some(
      (decision) =>
        decision.status === 'vetoed' && decision.reason === 'unknown_evidence_reference',
    ),
  ).toBe(true);
  expect(strategy.latestDecision).toMatchObject({
    status: 'fallback',
    assessedAt: NOW + 5000,
    fallbackReason: 'unknown_evidence_reference',
  });
  expect(strategy.account.pendingIntents[0].evaluatedAt).toBe(NOW + 5000);
  expect(strategy.account.pendingIntents[0].candidatePolicyVersion).toBeUndefined();
});

test('expired and superseded requests cannot create backdated recommendations', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const pending = request(state);
  expect(() =>
    recordAdvisorLanguageModelResult(state, {
      requestId: 'other-request',
      result: resultFor(state),
      observedAt: NOW + 4000,
    }),
  ).toThrow();
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 30000));
  expect(state.strategies['language-model'].latestDecision).toMatchObject({
    status: 'fallback',
    assessedAt: NOW + 30000,
    fallbackReason: 'response_expired',
  });
  const before = JSON.parse(JSON.stringify(state.strategies['language-model'].account));
  const late = {
    requestId: pending.requestId,
    evidence: pending.evidence,
    result: { status: 'timeout', respondedAt: NOW + 31000, inferenceCostUsd: 0.003 },
    observedAt: NOW + 31000,
  };
  state = recordAdvisorLanguageModelResult(state, late);
  expect(state.strategies['language-model'].account).toEqual(before);
  expect(state.strategies['language-model'].latestDecision.reason).toBe('superseded_response');
  expect(state.strategies['language-model'].inferenceCost).toBe(0.003);
  expect(recordAdvisorLanguageModelResult(state, late)).toEqual(state);
});

test('closed outcomes include inference cost in reported net profit without promoting a candidate', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result: resultFor(state),
    observedAt: NOW + 4000,
  });
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 7000, false));
  const settledAt = contract.expiresAt + 1000;
  state = advanceAdvisorHistoryTrial(state, {
    kind: 'settlement',
    observedAt: settledAt,
    market: outcomeAt(settledAt),
  });
  const language = state.strategies['language-model'];
  expect(language.account.positions).toHaveLength(0);
  expect(language.account.pendingComparisons).toHaveLength(0);
  const report = getAdvisorHistoryTrialReport(state);
  const result = report.strategies.find((item) => item.id === 'language-model');
  expect(result.netProfit).toBeCloseTo(language.account.realizedPnl - 0.003, 7);
  expect(result.readyForReview).toBe(false);
  expect(report).toMatchObject({
    automaticPromotion: false,
    requiresExplicitReview: true,
    settledCount: 1,
  });
});

test('contract changes and out-of-order observations cannot alter the fixed cohort', () => {
  const state = advanceAdvisorHistoryTrial(trial(), observation());
  expect(() =>
    advanceAdvisorHistoryTrial(state, {
      ...observation(NOW + 1000),
      contract: { ...contract, target: 76000 },
    }),
  ).toThrow(/target or deadline/);
  expect(() => advanceAdvisorHistoryTrial(state, observation(NOW - 1))).toThrow(/chronological/);
});

test('a cost received after final settlement updates drawdown without another market tick', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const pending = request(state);
  const settledAt = contract.expiresAt + 1000;
  state = advanceAdvisorHistoryTrial(state, {
    kind: 'settlement',
    observedAt: settledAt,
    market: outcomeAt(settledAt),
  });
  state = recordAdvisorLanguageModelResult(state, {
    requestId: pending.requestId,
    evidence: pending.evidence,
    result: { status: 'timeout', respondedAt: settledAt + 1000, inferenceCostUsd: 0.03 },
    observedAt: settledAt + 1000,
  });
  const result = getAdvisorHistoryTrialReport(state).strategies.find(
    (strategy) => strategy.id === 'language-model',
  );
  expect(result.netProfit).toBeCloseTo(-0.03, 7);
  expect(result.drawdown).toBeCloseTo(0.03, 7);
});

test('a recorded response advances chronology and cannot arrive before later account evidence', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const result = resultFor(state);
  const requestId = request(state).requestId;
  state = recordAdvisorLanguageModelResult(state, { requestId, result, observedAt: NOW + 4000 });
  expect(() => advanceAdvisorHistoryTrial(state, observation(NOW + 3000))).toThrow(/chronological/);
  const fresh = advanceAdvisorHistoryTrial(trial(), observation());
  const advanced = advanceAdvisorHistoryTrial(fresh, observation(NOW + 5000, false));
  expect(() =>
    recordAdvisorLanguageModelResult(advanced, { requestId, result, observedAt: NOW + 4000 }),
  ).toThrow(/backdated/);
});

test('AI guidance describes its own paper account and an accepted order becomes completed history after filling', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result: resultFor(state),
    observedAt: NOW + 4000,
  });
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  let report = guidanceFor(state);
  expect(report.accountId).toBe('trial-test:language-model');
  expect(report.source).toMatchObject({
    kind: 'ai',
    status: 'accepted',
    decision: { action: 'BUY_YES', assessedAt: NOW + 5000 },
  });
  expect(report.portfolio.cash).toBe(state.strategies['language-model'].account.cash);
  expect(report.currentPlan.accountVersion).toBe(report.portfolio.accountVersion);
  expect(report.latestAdvice.id).toBe(report.portfolio.pendingIntents[0].id);
  expect(report.latestAdvice.forecastCapturedAt).toBe(NOW + 5000);
  for (const display of [
    report.latestAdvice,
    report.currentPlan.advice,
    ...report.recentActivity.filter((entry) => entry.kind === 'advice'),
  ]) {
    expect(display).not.toHaveProperty('book');
    expect(display).not.toHaveProperty('forecast');
    expect(display).not.toHaveProperty('portfolio');
    expect(display.evaluatedAt).toBe(NOW + 5000);
    expect(display.contract).toEqual(contract);
  }
  expect(report.latestAdvice.id).not.toBe(state.strategies.incumbent.account.pendingIntents[0]?.id);
  const active = getAdvisorPlanState({ report, market: contract, now: NOW + 5000 });
  expect(active.heading).toBe('BUY UP');
  expect(active.readiness).toBe('pending');
  expect(active.current).not.toBeNull();

  state = advanceAdvisorHistoryTrial(state, observation(NOW + 7000, false));
  report = guidanceFor(state);
  const filled = getAdvisorPlanState({ report, market: contract, now: NOW + 7000 });
  expect(report.latestAdvice.executionStatus).toBe('filled');
  expect(report.portfolio.positions).toHaveLength(1);
  expect(report.performance.fillCount).toBe(1);
  expect(report.performance.inferenceCost).toBe(0.003);
  expect(report.risk.isCurrent).toBe(true);
  expect(new Set(report.recentActivity.map((entry) => entry.id)).size).toBe(
    report.recentActivity.length,
  );
  expect(filled.heading).toBe('UP PURCHASED');
  expect(filled.current).toBeNull();
  expect(filled.readiness).toBe('filled');
  expect(filled.completedFill.adviceId).toBe(report.latestAdvice.id);
});

test('pending and proposed AI responses preserve the last accepted assessment without renewing it', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result: resultFor(state, 'NO_TRADE'),
    observedAt: NOW + 4000,
  });
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  const accepted = guidanceFor(state);
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 30000));
  let report = guidanceFor(state);
  expect(report.source).toMatchObject({
    kind: 'ai',
    pending: true,
    decision: { action: 'NO_TRADE', status: 'accepted' },
    latestDecision: { status: 'pending' },
  });
  expect(report.currentPlan).toEqual(accepted.currentPlan);
  expect(getAdvisorPlanState({ report, market: contract, now: NOW + 30000 })).toMatchObject({
    heading: 'NO TRADE',
    active: { adviceId: accepted.currentPlan.adviceId },
    historical: null,
    current: null,
    readiness: 'stale',
  });

  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result: resultFor(state),
    observedAt: NOW + 34000,
  });
  report = guidanceFor(state);
  expect(report.source.latestDecision).toMatchObject({ action: 'BUY_YES', status: 'proposed' });
  expect(report.source.decision).toEqual(accepted.source.decision);
  expect(report.currentPlan).toEqual(accepted.currentPlan);
  expect(report.collector.heartbeatAt).toBe(NOW + 30000);
  expect(report.latestAdvice).toEqual(accepted.latestAdvice);
});

test('a rejected AI response clearly reports a numerical fallback from the AI account', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const result = resultFor(state);
  result.output.evidenceRefs = ['invented-evidence'];
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result,
    observedAt: NOW + 4000,
  });
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  const report = guidanceFor(state);
  expect(report.source).toMatchObject({
    kind: 'numerical-fallback',
    status: 'fallback',
    pending: false,
    decision: { fallbackReason: 'unknown_evidence_reference' },
  });
  expect(report.source.decision.rationale).toBeUndefined();
  expect(report.latestAdvice.candidatePolicyVersion).toBeUndefined();
  expect(report.currentPlan.adviceId).toBe(report.portfolio.pendingIntents[0].id);
});

test('missing market evidence does not schedule a paid AI request or invent a current assessment', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation(NOW, true, null));
  expect(request(state)).toBeNull();
  expect(state.strategies['language-model'].lastRequestAt).toBeNull();
  const report = guidanceFor(state);
  expect(report.source).toMatchObject({
    kind: 'numerical-fallback',
    decision: { fallbackReason: 'book_unavailable_or_noncausal' },
  });
  expect(report.portfolio.pendingIntents).toHaveLength(0);
  expect(report.portfolio.cash).toBe(100);
  expect(report.currentPlan.action).toBe('unavailable');

  state = advanceAdvisorHistoryTrial(state, observation(NOW + policy.cadenceMs));
  expect(request(state).evidence.available).toBe(true);
});

test('a sole no-trade choice updates the local plan without spending or delaying a later AI choice', () => {
  const noTradeObservation = (at) => ({
    ...observation(at),
    forecast: forecastAt(at, 0.5),
  });
  let state = advanceAdvisorHistoryTrial(trial(), noTradeObservation(NOW));
  state = advanceAdvisorHistoryTrial(state, noTradeObservation(NOW + policy.cadenceMs));
  const strategy = state.strategies['language-model'];
  expect(strategy.pendingRequest).toBeNull();
  expect(strategy.lastRequestAt).toBeNull();
  expect(strategy.inferenceCost).toBe(0);
  expect(strategy.failureCount).toBe(0);
  expect(strategy.vetoCount).toBe(0);
  expect(strategy.account.pendingIntents).toHaveLength(0);
  expect(guidanceFor(state)).toMatchObject({
    source: {
      kind: 'numerical',
      status: 'local',
      pending: false,
      providerReason: null,
      decision: { action: 'NO_TRADE' },
    },
    currentPlan: { action: 'no-trade' },
  });

  state = advanceAdvisorHistoryTrial(state, observation(NOW + policy.cadenceMs * 2));
  expect(request(state).evidence.options.map((option) => option.action)).toEqual([
    'NO_TRADE',
    'BUY_YES',
  ]);
  expect(state.strategies['language-model'].lastRequestAt).toBe(NOW + policy.cadenceMs * 2);
});

test('a local no-trade observation does not discard an in-flight AI decision', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  const pending = request(state);
  state = advanceAdvisorHistoryTrial(state, {
    ...observation(NOW + 5000),
    forecast: forecastAt(NOW + 5000, 0.5),
  });
  expect(request(state)).toEqual(pending);
  expect(state.strategies['language-model'].latestDecision.status).toBe('pending');
});

test('provider failure details explain the numerical fallback without disguising it as an AI decision', () => {
  let state = advanceAdvisorHistoryTrial(trial(), observation());
  state = recordAdvisorLanguageModelResult(state, {
    requestId: request(state).requestId,
    result: {
      status: 'provider_error',
      reason: 'provider_quota_exceeded',
      respondedAt: NOW + 4000,
      inferenceCostUsd: 0,
    },
    observedAt: NOW + 4000,
  });
  state = advanceAdvisorHistoryTrial(state, observation(NOW + 5000));
  expect(guidanceFor(state).source).toMatchObject({
    kind: 'numerical-fallback',
    providerReason: 'provider_quota_exceeded',
    decision: { fallbackReason: 'provider_quota_exceeded' },
  });
});

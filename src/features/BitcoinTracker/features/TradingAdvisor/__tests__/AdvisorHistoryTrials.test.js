/** @jest-environment node */
import {
  advanceAdvisorHistoryTrial,
  createAdvisorHistoryTrial,
  getAdvisorHistoryTrialReport,
  recordAdvisorLanguageModelResult,
} from '@/services/research/tradingAdvisor/advisorHistoryTrials.utils';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
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

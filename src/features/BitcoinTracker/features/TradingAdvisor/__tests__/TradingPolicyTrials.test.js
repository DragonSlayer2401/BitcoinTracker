import {
  advanceTradingPolicyTrial,
  createTradingPolicyTrial,
  getTradingPolicyComparison,
  getTradingPolicyEligibility,
  getTradingPolicyPendingExecutions,
  getTradingPolicyTrialReport,
  TRADING_POLICY_TRIAL_RULES,
} from '@/services/research/tradingAdvisor/tradingPolicyTrials.utils';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import { START, bookAt, contract, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

const policy = createTradingAdvisorPolicy({
  allocation: 100,
  riskLevel: 'balanced',
  runId: 'trial-tests',
});
const initial = () => createTradingPolicyTrial(policy, START - 1000);
const observe = (state, at, options = {}) =>
  advanceTradingPolicyTrial(state, {
    kind: 'observation',
    contract,
    book: bookAt(at),
    forecast: forecastAt(at),
    observedAt: at,
    ...options,
  });
const settle = (state, at = contract.expiresAt, result = 'yes') =>
  advanceTradingPolicyTrial(state, {
    kind: 'settlement',
    market: outcomeAt(at, result),
    observedAt: at,
  });

function scoredTrial({ candidateProfit = 0.2, baselineProfit = 0.1, resolved = 120 } = {}) {
  const state = initial();
  state.contracts = Array.from({ length: 120 }, (_, index) => ({
    cohort: 'confirmation',
    contract: {
      ...contract,
      ticker: `KXBTC15M-TRIAL-${index}`,
      eventTicker: `KXBTC15M-TRIAL-${index}`,
      startsAt: START + index * 900000,
      expiresAt: START + (index + 1) * 900000,
    },
    enrolledAt: START + index * 900000,
    outcome: index < resolved ? { result: 'yes' } : null,
    scores: Object.fromEntries(
      Object.keys(state.strategies).map((id) => [
        id,
        {
          netProfit: id === 'selective-entry' ? candidateProfit : baselineProfit,
          entryFills: 1,
          orderCount: 1,
          orderFills: 1,
          fees: 0.01,
        },
      ]),
    ),
  }));
  return state;
}

test('freezes equal allocation and risk limits while changing one strategy parameter at a time', () => {
  const state = initial();
  expect(state.rules).toEqual(TRADING_POLICY_TRIAL_RULES);
  for (const strategy of Object.values(state.strategies)) {
    expect(strategy.account.cash).toBe(100);
    for (const key of [
      'initialBankroll',
      'maxOpenRisk',
      'maxPositionCost',
      'maxDailyLoss',
      'maxDrawdown',
    ])
      expect(strategy.policy[key]).toBe(policy[key]);
    expect(strategy.policy.id).toBe(policy.id);
  }
  expect(state.strategies['selective-entry'].policy.minimumEntryEdge).toBe(0.04);
  expect(state.strategies['early-exit'].policy.minimumExitAdvantage).toBe(0.005);
  expect(state.strategies['cautious-sizing'].policy.fractionalKelly).toBe(0.125);
});

test('only enrolls an active new contract after registration, never historical or existing-window evidence', () => {
  const late = createTradingPolicyTrial(policy, START + 1);
  expect(observe(late, START + 60000).contracts).toHaveLength(0);
  expect(observe(initial(), START - 500).contracts).toHaveLength(0);
  expect(observe(initial(), contract.expiresAt).contracts).toHaveLength(0);
  const captured = observe(initial(), START + 60000);
  expect(captured.contracts).toHaveLength(1);
  expect(initial().contracts).toHaveLength(0);
  expect(() =>
    observe(captured, START + 61000, { contract: { ...contract, target: 75001 } }),
  ).toThrow('settlement identity');
});

test('shares one later observed book across independent accounts and counts fees in final profit', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  expect(state.strategies.standard.account.pendingIntents).toHaveLength(1);
  const quantity = state.strategies.standard.account.pendingIntents[0].quantity;
  state = observe(state, at + 2000, { forecast: undefined });
  const position = state.strategies.standard.account.positions[0];
  expect(position.quantity).toBe(quantity);
  expect(position.entryFees).toBeGreaterThan(0);
  expect(state.strategies['cautious-sizing'].account.positions[0].quantity).toBeLessThanOrEqual(
    quantity,
  );
  state = settle(state);
  const score = state.contracts[0].scores.standard;
  expect(score.netProfit).toBeCloseTo(quantity - position.costBasis, 7);
  expect(state.strategies.standard.account.cash).toBeCloseTo(100 + score.netProfit, 7);
  expect(state.strategies.standard.account.pendingComparisons).toHaveLength(0);
  expect(state.contracts[0].outcome.result).toBe('yes');
});

test('shares an execution request only with strategies whose minimum delay has elapsed', () => {
  const at = START + 60000;
  const previous = initial();
  previous.strategies['selective-entry'].account.lastAdviceAt = at - 14000;
  let state = observe(previous, at);
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(3);
  state = observe(state, at + 1000);
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(4);
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'earlier-orders',
    observedAt: at + 2000,
  });
  const pending = getTradingPolicyPendingExecutions(state);
  expect(pending.filter(({ attempt }) => attempt?.sourceId === 'earlier-orders')).toHaveLength(3);
  expect(pending.find(({ advice }) => advice.policy.strategyId === 'selective-entry').attempt).toBe(
    null,
  );

  state = observe(state, at + 3500, {
    forecast: undefined,
    sourceId: 'earlier-orders',
    book: { ...bookAt(at + 3500), requestedAt: at + 2000 },
  });
  for (const id of ['standard', 'early-exit', 'cautious-sizing']) {
    expect(state.strategies[id].account.positions).toHaveLength(1);
    expect(state.strategies[id].account.pendingIntents).toHaveLength(0);
  }
  expect(state.strategies['selective-entry'].account.positions).toHaveLength(0);
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(1);

  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'later-order',
    observedAt: at + 3500,
  });
  state = observe(state, at + 3501, {
    forecast: undefined,
    sourceId: 'later-order',
    book: { ...bookAt(at + 3501), requestedAt: at + 3500 },
  });
  expect(state.strategies['selective-entry'].account.positions).toHaveLength(1);
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(0);
});

test('a failed shared request cancels every claimed order without fetching a later opportunity', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'too-early',
    observedAt: at + 1999,
  });
  expect(getTradingPolicyPendingExecutions(state).every(({ attempt }) => attempt === null)).toBe(
    true,
  );
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'failed-request',
    observedAt: at + 2000,
  });
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(4);
  for (const { attempt } of getTradingPolicyPendingExecutions(state))
    expect(attempt).toMatchObject({
      sourceId: 'failed-request',
      requestedAt: at + 2000,
      deadline: at + policy.maximumFillDelayMs + 1,
    });
  state = observe(state, at + 2001, {
    forecast: undefined,
    sourceId: 'failed-request',
    book: null,
  });
  state = observe(state, at + 3000, { forecast: undefined });
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(0);
  for (const strategy of Object.values(state.strategies)) {
    expect(strategy.account.cash).toBe(100);
    expect(strategy.account.positions).toHaveLength(0);
    expect(state.contracts[0].scores[strategy.id].orderFills).toBe(0);
  }
});

test('a lost shared request remains claimed after restart and expires without a favorable retry', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'lost-request',
    observedAt: at + 2000,
  });
  state = JSON.parse(JSON.stringify(state));
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'restarted-request',
    observedAt: at + 3000,
  });
  state = observe(state, at + 3001, {
    forecast: undefined,
    sourceId: 'restarted-request',
  });
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(4);
  for (const { attempt } of getTradingPolicyPendingExecutions(state))
    expect(attempt.sourceId).toBe('lost-request');
  for (const strategy of Object.values(state.strategies))
    expect(strategy.account.positions).toHaveLength(0);

  state = observe(state, at + policy.maximumFillDelayMs + 1, {
    forecast: undefined,
    book: null,
  });
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(0);
  for (const strategy of Object.values(state.strategies)) {
    expect(strategy.account.cash).toBe(100);
    expect(strategy.account.positions).toHaveLength(0);
  }
});

test.each([
  ['price beyond the limit', (book) => ({ ...book, yesAsks: [{ price: 0.99, quantity: 100 }] })],
  ['missing depth', (book) => ({ ...book, yesAsks: [] })],
  ['unavailable fees', (book) => ({ ...book, fee: { available: false } })],
])('a shared execution request still rejects %s', (_reason, changeBook) => {
  const at = START + 60000;
  let state = observe(initial(), at);
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'checked-request',
    observedAt: at + 2000,
  });
  state = observe(state, at + 2001, {
    forecast: undefined,
    sourceId: 'checked-request',
    book: changeBook({ ...bookAt(at + 2001), requestedAt: at + 2000 }),
  });
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(0);
  for (const strategy of Object.values(state.strategies)) {
    expect(strategy.account.cash).toBe(100);
    expect(strategy.account.positions).toHaveLength(0);
    expect(state.contracts[0].scores[strategy.id].orderFills).toBe(0);
  }
});

test('a claimed shared book arriving after the execution deadline cannot fill any strategy', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  state = advanceTradingPolicyTrial(state, {
    kind: 'execution-request',
    contract,
    sourceId: 'late-request',
    observedAt: at + 2000,
  });
  const arrivedAt = at + policy.maximumFillDelayMs + 1;
  state = observe(state, arrivedAt, {
    forecast: undefined,
    sourceId: 'late-request',
    book: { ...bookAt(arrivedAt), requestedAt: at + 2000 },
  });
  expect(getTradingPolicyPendingExecutions(state)).toHaveLength(0);
  for (const strategy of Object.values(state.strategies)) {
    expect(strategy.account.cash).toBe(100);
    expect(strategy.account.positions).toHaveLength(0);
  }
});

test('missing timely execution observations release all reserved cash without inventing a fill', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  expect(state.strategies.standard.account.cash).toBeLessThan(100);
  state = observe(state, at + 16000, { forecast: undefined, book: null });
  expect(state.strategies.standard.account.cash).toBe(100);
  expect(state.strategies.standard.account.pendingIntents).toHaveLength(0);
  expect(state.contracts[0].scores.standard.orderFills).toBe(0);
  state = settle(state);
  expect(state.contracts[0].scores.standard.netProfit).toBe(0);
});

test('does not fill a shadow entry using its own decision snapshot', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  state = observe(state, at + 2000, { forecast: undefined, book: bookAt(at) });
  expect(state.strategies.standard.account.positions).toHaveLength(0);
  expect(state.strategies.standard.account.cash).toBe(100);
});

test('partial observed liquidity fills only the available quantity and cancels the remainder', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  expect(state.strategies.standard.account.pendingIntents[0].quantity).toBeGreaterThan(1);
  state = observe(state, at + 2000, {
    forecast: undefined,
    book: { ...bookAt(at + 2000), yesAsks: [{ price: 0.5, quantity: 1 }] },
  });
  expect(state.strategies.standard.account.positions[0].quantity).toBe(1);
  expect(state.strategies.standard.account.pendingIntents).toHaveLength(0);
});

test('a partial sale cannot value its remaining inventory using the consumed bids', () => {
  const at = START + 60000;
  let state = observe(initial(), at);
  state = observe(state, at + 2000, { forecast: undefined });
  const exitAt = at + 15000;
  const exitBook = (time, quantity = 100) => ({
    ...bookAt(time),
    yesAsks: [{ price: 0.95, quantity: 100 }],
    noAsks: [{ price: 0.1, quantity }],
  });
  state = observe(state, exitAt, { forecast: forecastAt(exitAt, 0.4), book: exitBook(exitAt) });
  expect(state.strategies.standard.account.pendingIntents[0].action).toBe('sell');
  state = observe(state, exitAt + 2000, { forecast: undefined, book: exitBook(exitAt + 2000, 1) });
  expect(state.strategies.standard.account.positions[0].quantity).toBeGreaterThan(0);
  expect(state.strategies.standard.risk.valuation.complete).toBe(false);
  state = observe(state, exitAt + 3000, { forecast: undefined, book: exitBook(exitAt + 3000) });
  expect(state.strategies.standard.risk.valuation.complete).toBe(true);
});

test('a missing outcome remains part of the fixed cohort, and later contracts cannot substitute', () => {
  const state = scoredTrial({ resolved: 119 });
  const laterStart = START + 120 * 900000;
  const later = {
    ...contract,
    ticker: 'KXBTC15M-LATER',
    eventTicker: 'KXBTC15M-LATER',
    startsAt: laterStart,
    expiresAt: laterStart + 900000,
  };
  const result = observe(state, laterStart + 60000, {
    contract: later,
    forecast: { available: false },
    book: null,
  });
  expect(result.contracts).toHaveLength(120);
  expect(result.phase).toBe('collecting');
  expect(
    getTradingPolicyEligibility(result, 'selective-entry', laterStart + 60000).reasons,
  ).toContain('fixed_sample_incomplete');
  expect(getTradingPolicyTrialReport(result, laterStart + 60000).missingOutcomes).toEqual([
    'KXBTC15M-TRIAL-119',
  ]);
});

test('promotion requires profitable paired results, observed trading coverage and acceptable drawdown', () => {
  const state = scoredTrial();
  const at = START + 121 * 900000;
  expect(getTradingPolicyEligibility(state, 'selective-entry', at).eligible).toBe(true);
  expect(
    getTradingPolicyEligibility(
      scoredTrial({ candidateProfit: -0.1, baselineProfit: -0.2 }),
      'selective-entry',
      at,
    ).reasons,
  ).toContain('candidate_not_profitable');
  expect(
    getTradingPolicyEligibility(scoredTrial({ candidateProfit: 0.1 }), 'selective-entry', at)
      .reasons,
  ).toContain('paired_profit_advantage_unproven');
  state.strategies['selective-entry'].risk = { history: { maxDrawdown: 5 } };
  expect(getTradingPolicyEligibility(state, 'selective-entry', at).reasons).toContain(
    'additional_drawdown_too_large',
  );
  state.strategies['selective-entry'].risk = null;
  for (const row of state.contracts) row.scores['selective-entry'].entryFills = 0;
  expect(getTradingPolicyEligibility(state, 'selective-entry', at).reasons).toContain(
    'too_few_candidate_trades',
  );
});

test('flat decisions stay in paired profit comparisons instead of removing losing opportunities', () => {
  const state = scoredTrial({ candidateProfit: 0 });
  expect(getTradingPolicyComparison(state, 'selective-entry')).toMatchObject({
    resolvedContracts: 120,
    candidateProfit: 0,
    baselineProfit: 12,
    pairedAdvantage: -12,
  });
});

test('records one promotion, then rolls back on new prospective profit deterioration', () => {
  const at = START + 121 * 900000;
  let state = observe(scoredTrial(), at, { forecast: undefined, book: null, contract: null });
  expect(state.phase).toBe('active');
  expect(state.activeStrategyId).toBe('selective-entry');
  expect(state.transitions).toHaveLength(1);
  state.contracts.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      cohort: 'monitoring',
      contract: {
        ...contract,
        ticker: `KXBTC15M-MONITOR-${index}`,
        startsAt: at + index * 900000,
        expiresAt: at + (index + 1) * 900000,
      },
      outcome: { result: 'no' },
      scores: Object.fromEntries(
        Object.keys(state.strategies).map((id) => [
          id,
          {
            netProfit: id === 'selective-entry' ? -0.2 : 0,
            entryFills: 1,
            orderCount: 1,
            orderFills: 1,
            fees: 0.01,
          },
        ]),
      ),
    })),
  );
  state = observe(state, at + 21 * 900000, { forecast: undefined, book: null, contract: null });
  expect(state.phase).toBe('rolled-back');
  expect(state.activeStrategyId).toBe('standard');
  expect(state.transitions[1].reason).toBe('prospective_profit_deterioration');
  const restarted = observe(state, at + 22 * 900000, {
    forecast: undefined,
    book: null,
    contract: null,
  });
  expect(restarted.phase).toBe('rolled-back');
  expect(restarted.transitions).toHaveLength(2);
});

test('rejects a completed losing trial once instead of repeatedly testing additional samples', () => {
  const at = START + 121 * 900000;
  const state = observe(scoredTrial({ candidateProfit: 0.05 }), at, {
    forecast: undefined,
    book: null,
    contract: null,
  });
  expect(state.phase).toBe('rejected');
  expect(state.activeStrategyId).toBe('standard');
});

test('rejects backwards observations and ignores unverified or premature settlements', () => {
  const state = observe(initial(), START + 60000);
  expect(() => observe(state, START + 1000)).toThrow('chronological');
  expect(
    advanceTradingPolicyTrial(state, {
      kind: 'settlement',
      market: { ...outcomeAt(contract.expiresAt), status: 'closed' },
      observedAt: contract.expiresAt,
    }).contracts[0].outcome,
  ).toBeNull();
});

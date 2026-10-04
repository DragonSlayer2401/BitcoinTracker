/** @jest-environment node */
import {
  createTradingAdvisorPolicy,
  getAdvisorOpportunityBudget,
} from '../utils/advisorPolicy.utils';
import {
  getTradingAdvice,
  isTradingAdvisorPolicy,
  simulateTradingExecution,
} from '../utils/tradingAdvisor.utils';
import { getAdvisorValuation } from '../utils/advisorValuation.utils';
import {
  createAdvisorAccount,
  getAdvisorPortfolio,
  withAdvisorDailyEquity,
  applyAdvisorAdvice,
  applyAdvisorEvent,
} from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { START, contract, bookAt, forecastAt } from './TradingAdvisor.fixtures';

const NOW = START + 300000;
const policy = createTradingAdvisorPolicy({ runId: 'engine-test', dailyLossLimitEnabled: true });
const mark = (account, now = NOW, book = bookAt(now), released = null) => {
  const portfolio = getAdvisorPortfolio(account, now, released);
  const valuation = getAdvisorValuation({ portfolio, books: [book], now, policy });
  const observed = withAdvisorDailyEquity(account, valuation, now);
  return {
    ...getAdvisorPortfolio(observed, now, released),
    valuation,
    riskHistory: { peakEquity: 100 },
  };
};
const adviceFor = (
  account = createAdvisorAccount(policy),
  now = NOW,
  probability = 0.85,
  book = bookAt(now),
) => {
  const portfolio = mark(account, now, book);
  return {
    ...getTradingAdvice({
      contract,
      book,
      forecast: forecastAt(now, probability),
      portfolio,
      now,
      policy,
    }),
    id: `advice-${now}`,
    portfolio,
  };
};
const execute = (advice, account, book, now) => ({
  ...simulateTradingExecution({
    advice,
    book,
    portfolio: mark(account, now, book, advice.id),
    now,
  }),
  adviceId: advice.id,
});
const partialEntry = () => {
  const advice = adviceFor();
  const reserved = applyAdvisorAdvice(createAdvisorAccount(policy), advice);
  const book = { ...bookAt(NOW + 2000), yesAsks: [{ price: 0.5, quantity: 3 }] };
  const event = execute(advice, reserved, book, NOW + 2000);
  return { advice, event, reserved, account: applyAdvisorEvent(reserved, event).account };
};

test.each([0, 0.99, -1, 100.01, 101, NaN, 12.345])(
  'rejects allocation outside a positive cent amount up to $100: %s',
  (allocation) => {
    expect(() => createTradingAdvisorPolicy({ allocation })).toThrow();
  },
);

test('scales hard caps with user allocation and preserves separate experiment identities', () => {
  const smaller = createTradingAdvisorPolicy({
    allocation: 25,
    riskLevel: 'balanced',
    runId: 'run-one',
  });
  expect(smaller).toMatchObject({
    initialBankroll: 25,
    maxPositionCost: 2.5,
    maxOpenRisk: 5,
    maxDailyLoss: 2,
  });
  expect(isTradingAdvisorPolicy(smaller)).toBe(true);
  const cautious = createTradingAdvisorPolicy({
    allocation: 25,
    riskLevel: 'balanced',
    runId: 'run-one',
    variant: 'cautious-sizing',
  });
  expect(cautious.id).toBe(smaller.id);
  expect(cautious.fractionalKelly).toBe(0.125);
  expect(isTradingAdvisorPolicy({ ...smaller, maxPositionCost: 25 })).toBe(false);
});

test('requires fresh complete equity before a new buy and rejects marks from another account policy', () => {
  const input = { contract, book: bookAt(NOW), forecast: forecastAt(NOW), now: NOW, policy };
  const portfolio = mark(createAdvisorAccount(policy));
  expect(getTradingAdvice({ ...input, portfolio }).action).toBe('buy');
  for (const valuation of [
    null,
    { ...portfolio.valuation, complete: false },
    { ...portfolio.valuation, validUntil: NOW },
    { ...portfolio.valuation, policyId: 'other' },
  ]) {
    expect(getTradingAdvice({ ...input, portfolio: { ...portfolio, valuation } })).toMatchObject({
      action: 'wait',
      reason: 'risk_valuation_unavailable_or_stale',
    });
  }
});

test('sizes within the entire possible daily loss budget, including fees at the limit', () => {
  const advice = adviceFor();
  expect(advice.action).toBe('buy');
  expect(advice.maxCost).toBeLessThanOrEqual(policy.maxDailyLoss);
  expect(advice.maxCost).toBeLessThanOrEqual(advice.opportunityBudget);
  expect(advice.maxCost).toBeLessThanOrEqual(policy.maxPositionCost);
  expect(advice.probabilityStatus).toBe('unvalidated-estimate');
  const cautious = getAdvisorOpportunityBudget({
    probability: 0.65,
    priceWithFees: 0.53,
    equity: 100,
    policy,
  });
  const strong = getAdvisorOpportunityBudget({
    probability: 0.85,
    priceWithFees: 0.53,
    equity: 100,
    policy,
  });
  expect(cautious).toBeLessThan(strong);
});

test.each([
  [{ riskHistory: { peakEquity: 111 } }, 'equity_drawdown_limit'],
  [{ dailyStartEquity: 106 }, 'daily_equity_loss_limit'],
  [{ lastExitAt: NOW - 1000 }, 'reentry_cooldown'],
  [{ lastLossAt: NOW - 1000 }, 'loss_cooldown'],
  [{ openRisk: policy.maxDailyLoss }, 'portfolio_loss_capacity_exhausted'],
])('enforces equity, correlated risk, and cooldown limits: %s', (patch, reason) => {
  const portfolio = { ...mark(createAdvisorAccount(policy)), ...patch };
  expect(
    getTradingAdvice({
      contract,
      book: bookAt(NOW),
      forecast: forecastAt(NOW),
      now: NOW,
      policy,
      portfolio,
    }),
  ).toMatchObject({ action: 'wait', reason });
});

test('partially fills once, releases all unused cash, and cannot replay the canceled remainder', () => {
  const { advice, event, reserved, account } = partialEntry();
  expect(advice.quantity).toBeGreaterThan(3);
  expect(event).toMatchObject({
    kind: 'fill',
    quantity: 3,
    requestedQuantity: advice.quantity,
    canceledQuantity: advice.quantity - 3,
    timeInForce: 'IOC',
    fullyCovered: false,
    reason: 'partial_fill_remainder_canceled',
  });
  expect(account.pendingIntents).toHaveLength(0);
  expect(account.cash).toBeCloseTo(100 - event.totalCost, 7);
  expect(account.positions[0].costBasis).toBe(event.totalCost);
  expect(reserved.cash).toBeCloseTo(100 - advice.maxCost, 7);
  expect(() => applyAdvisorEvent(account, event)).toThrow(/unconsumed/);
});

test('partial sale realizes only the filled proportion and releases the unfilled sell reservation', () => {
  const entry = partialEntry();
  const time = NOW + 15000;
  const advice = adviceFor(entry.account, time, 0.05);
  expect(advice.action).toBe('sell');
  const reserved = applyAdvisorAdvice(entry.account, advice);
  const book = { ...bookAt(time + 2000), noAsks: [{ price: 0.55, quantity: 1 }] };
  const event = execute(advice, reserved, book, time + 2000);
  const { account, realizedPnl } = applyAdvisorEvent(reserved, event);
  expect(event).toMatchObject({
    kind: 'fill',
    quantity: 1,
    canceledQuantity: 2,
    fullyCovered: false,
  });
  expect(account.positions[0].quantity).toBe(2);
  expect(account.positions[0].costBasis).toBeCloseTo((entry.event.totalCost * 2) / 3, 7);
  expect(realizedPnl).toBeCloseTo(event.netProceeds - entry.event.totalCost / 3, 7);
  expect(getAdvisorPortfolio(account, time + 2000).positions[0].availableQuantity).toBe(2);
  expect(account.pendingIntents).toHaveLength(0);
  expect(account.lastExitAt).toBe(time + 2000);
  expect(account.lastLossAt).toBe(time + 2000);
});

test('partial execution cannot cross its limit and does not retry favorable later quotes', () => {
  const advice = adviceFor();
  const reserved = applyAdvisorAdvice(createAdvisorAccount(policy), advice);
  const time = NOW + 2000;
  const book = {
    ...bookAt(time),
    yesAsks: [
      { price: 0.5, quantity: 2 },
      { price: 0.95, quantity: 10 },
    ],
  };
  const event = execute(advice, reserved, book, time);
  expect(event).toMatchObject({ kind: 'fill', quantity: 2 });
  expect(event.fills.every((fill) => fill.price <= advice.limitPrice)).toBe(true);
  const next = applyAdvisorEvent(reserved, event).account;
  expect(() => applyAdvisorEvent(next, { ...event, recordedAt: time + 2000 })).toThrow();
});

test('rechecks risk at delayed execution and terminal no-fill releases every reserved dollar', () => {
  const advice = adviceFor();
  const reserved = applyAdvisorAdvice(createAdvisorAccount(policy), advice);
  const time = NOW + 2000;
  const portfolio = {
    ...mark(reserved, time, bookAt(time), advice.id),
    riskHistory: { peakEquity: 111 },
  };
  const event = {
    ...simulateTradingExecution({ advice, book: bookAt(time), portfolio, now: time }),
    adviceId: advice.id,
  };
  expect(event).toMatchObject({
    kind: 'no-fill',
    reason: 'equity_drawdown_limit',
    canceledQuantity: advice.quantity,
  });
  const next = applyAdvisorEvent(reserved, event).account;
  expect(next.cash).toBe(100);
  expect(next.pendingIntents).toHaveLength(0);
});

test('missing portfolio marks do not prevent managing an existing position', () => {
  const entry = partialEntry();
  const portfolio = getAdvisorPortfolio(entry.account, NOW + 15000);
  const advice = getTradingAdvice({
    contract,
    book: bookAt(NOW + 15000),
    forecast: forecastAt(NOW + 15000, 0.05),
    portfolio,
    now: NOW + 15000,
    policy,
  });
  expect(advice.action).toBe('sell');
  expect(advice.exitPlan).toMatchObject({
    side: 'yes',
    quantity: 3,
    basis: 'hold-value-plus-fees',
    costBasis: entry.event.totalCost,
  });
  expect(advice.exitPlan.netProceeds).toBeCloseTo(
    advice.exitPlan.grossProceeds - advice.exitPlan.estimatedFee,
    6,
  );
  expect(advice.exitPlan.estimatedProfit).toBeCloseTo(
    advice.exitPlan.netProceeds - entry.event.totalCost,
    6,
  );
  expect(advice.exitPlan.expiresAt).toBeLessThanOrEqual(contract.expiresAt);
});

test('the daily equity baseline changes once per UTC day and ignores stale marks', () => {
  const account = createAdvisorAccount(policy);
  const valuation = {
    complete: true,
    observedAt: NOW,
    validUntil: NOW + 1000,
    executableEquity: 98,
  };
  const first = withAdvisorDailyEquity(account, valuation, NOW);
  expect(first.dailyStartEquity).toBe(98);
  expect(
    withAdvisorDailyEquity(first, { ...valuation, executableEquity: 94 }, NOW).dailyStartEquity,
  ).toBe(98);
  expect(
    withAdvisorDailyEquity(account, { ...valuation, validUntil: NOW }, NOW).dailyStartEquity,
  ).toBeNull();
  expect(first.cash).toBe(account.cash);
  expect(first.version).toBe(account.version);
  const tomorrow = NOW + 86400000;
  const nextDay = withAdvisorDailyEquity(
    first,
    { ...valuation, observedAt: tomorrow, validUntil: tomorrow + 1000, executableEquity: 97 },
    tomorrow,
  );
  expect(nextDay.dailyStartEquity).toBe(97);
  expect(nextDay.equityDay).not.toBe(first.equityDay);
});

test('reports an unavailable sell limit rather than inventing a price above the contract payout', () => {
  const entry = partialEntry();
  const advice = adviceFor(entry.account, NOW + 15000, 0.99);
  expect(advice.action).toBe('hold');
  expect(advice.exitPlan).toMatchObject({
    available: false,
    limitPrice: null,
    quantity: 3,
    reason: 'no_fee_adjusted_sell_limit',
  });
});

test('does not discard the first new-day equity baseline when a delayed order expires', () => {
  const advice = adviceFor();
  const reserved = applyAdvisorAdvice(createAdvisorAccount(policy), advice);
  const time = NOW + 86400000;
  const portfolio = {
    ...getAdvisorPortfolio(reserved, time, advice.id),
    equityDay: new Date(time).toISOString().slice(0, 10),
    dailyStartEquity: 100,
  };
  const event = {
    ...simulateTradingExecution({ advice, book: null, portfolio, now: time }),
    adviceId: advice.id,
  };
  expect(event).toMatchObject({
    kind: 'no-fill',
    reason: 'execution_window_expired',
    dailyEquity: { day: portfolio.equityDay, startEquity: 100 },
  });
  const next = applyAdvisorEvent(reserved, event).account;
  expect(next.dailyStartEquity).toBe(100);
  expect(next.equityDay).toBe(portfolio.equityDay);
  expect(next.cash).toBe(100);
});

test('resizes a delayed order when other committed risk leaves only a smaller loss budget', () => {
  const advice = adviceFor();
  const reserved = applyAdvisorAdvice(createAdvisorAccount(policy), advice);
  const time = NOW + 2000;
  const portfolio = { ...mark(reserved, time, bookAt(time), advice.id), openRisk: 4 };
  const event = simulateTradingExecution({ advice, book: bookAt(time), portfolio, now: time });
  expect(event.kind).toBe('fill');
  expect(event.quantity).toBe(1);
  expect(event.totalCost).toBeLessThanOrEqual(1);
  expect(event.canceledQuantity).toBe(advice.quantity - 1);
});

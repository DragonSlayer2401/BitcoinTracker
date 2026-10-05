/** @jest-environment node */
import {
  TRADING_ADVISOR_POLICY,
  getTradingAdvice,
  getTradingExecutionQuote,
  isTradingAdvisorPolicy,
  simulateTradingExecution,
} from '../utils/tradingAdvisor.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../../../utils/kalshi/contract.utils';

const START = Date.UTC(2026, 9, 3, 12);
const NOW = START + 9 * 60000;
const contract = {
  ticker: 'KXBTC15M-26OCT031215-15',
  eventTicker: 'KXBTC15M-26OCT031215',
  seriesTicker: 'KXBTC15M',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  rulesVerified: true,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  target: 75000,
  startsAt: START,
  expiresAt: START + 900000,
};
const bookAt = (now = NOW) => ({
  ticker: contract.ticker,
  requestedAt: now,
  receivedAt: now,
  yesAsks: [{ price: 0.5, quantity: 100 }],
  noAsks: [{ price: 0.55, quantity: 100 }],
  fee: {
    available: true,
    type: 'quadratic',
    multiplier: 1,
    checkedAt: now,
    validUntil: now + 30000,
  },
});
const input = () => ({
  contract,
  forecast: {
    available: true,
    aboveProbability: 0.85,
    capturedAt: NOW,
    modelVersion: 'test-v1',
    modelId: null,
  },
  book: bookAt(),
  now: NOW,
  portfolio: { cash: 100, openRisk: 0, dailyRealizedPnl: 0, realizedPnl: 0, positions: [] },
});
const withPosition = (probability = 0.3) => {
  const value = input();
  value.forecast.aboveProbability = probability;
  value.portfolio = {
    ...value.portfolio,
    cash: 95,
    openRisk: 5,
    positions: [
      {
        id: 'position-1',
        contract,
        side: 'yes',
        quantity: 10,
        availableQuantity: 10,
        costBasis: 5,
        entryFees: 0.1,
        averagePrice: 0.49,
        openedAt: NOW - 30000,
      },
    ],
  };
  return value;
};
const execute = (advice, value = input(), patch = {}) =>
  simulateTradingExecution({
    advice,
    portfolio: value.portfolio,
    book: bookAt(NOW + 2000),
    now: NOW + 2000,
    ...patch,
  });

test('selects a sized fee-inclusive entry and preserves cash and risk reserves', () => {
  const advice = getTradingAdvice(input());
  expect(advice).toMatchObject({
    action: 'buy',
    side: 'yes',
    reason: 'fee_adjusted_entry_edge',
    policyId: 'kalshi-advisor-v1',
  });
  expect(advice.quantity).toBeGreaterThan(1);
  expect(advice.quantity).toBeLessThanOrEqual(20);
  expect(advice.maxCost).toBeLessThanOrEqual(10);
  expect(advice.quotedCost).toBeLessThanOrEqual(advice.maxCost);
  expect(advice.conservativeExpectedNetValue).toBeCloseTo(
    advice.expectedNetValue - 0.05 * advice.quantity,
  );
  expect(advice.quotedFee).toBeGreaterThan(0);
  expect(advice.limitPrice * 100).toBeCloseTo(Math.round(advice.limitPrice * 100), 10);
  expect(advice.exitPlan).toMatchObject({
    type: 'conditional_limit',
    quantity: advice.quantity,
    expiresAt: NOW + 15000,
  });
  expect(Object.isFrozen(advice.policy)).toBe(true);
  expect(advice.exitPlan.limitPrice * 100).toBeCloseTo(
    Math.round(advice.exitPlan.limitPrice * 100),
    10,
  );
});

test('can advise buying Down with the complementary probability', () => {
  const value = input();
  value.forecast.aboveProbability = 0.15;
  expect(getTradingAdvice(value)).toMatchObject({ action: 'buy', side: 'no', probability: 0.85 });
});

test('equal probabilities with no edge give Wait, never a forced directional purchase', () => {
  const value = input();
  value.forecast.aboveProbability = 0.5;
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'insufficient_entry_edge',
  });
});

test.each([
  [{ cash: 50 }, 'cash_reserve_limit'],
  [{ openRisk: 20 }, 'open_risk_limit'],
  [{ dailyRealizedPnl: -5 }, 'daily_loss_limit'],
  [{ dailyRealizedPnl: -6 }, 'daily_loss_limit'],
])('blocks a new entry when the risk limit is reached: %p', (portfolio, reason) => {
  const value = input();
  Object.assign(value.portfolio, portfolio);
  expect(getTradingAdvice(value)).toMatchObject({ action: 'wait', reason });
});

test('sizes to the smaller of remaining available cash and risk capacity', () => {
  const value = input();
  value.portfolio.cash = 51;
  value.portfolio.openRisk = 19.5;
  value.book.yesAsks = [{ price: 0.2, quantity: 100 }];
  value.book.noAsks = [{ price: 0.85, quantity: 100 }];
  const advice = getTradingAdvice(value);
  expect(advice.action).toBe('buy');
  expect(advice.maxCost).toBeLessThanOrEqual(0.5);
  expect(advice.quantity).toBe(2);
});

test('profits never expand the fixed $100 budget or default position cap', () => {
  const value = input();
  value.portfolio.cash = 1000;
  value.forecast.aboveProbability = 1;
  expect(getTradingAdvice(value).maxCost).toBeLessThanOrEqual(10);
  expect(isTradingAdvisorPolicy({ ...TRADING_ADVISOR_POLICY, totalBudget: 101 })).toBe(false);
});

test.each([
  { available: false },
  { aboveProbability: NaN },
  { aboveProbability: 1.1 },
  { capturedAt: NOW + 1 },
  { capturedAt: NOW - 5001 },
  { modelVersion: null },
  { marketTicker: 'KXBTC15M-WRONG' },
  { contract: { ...contract, target: 76000 } },
])('waits for usable forecast input %p even when a position exists', (patch) => {
  const value = withPosition();
  Object.assign(value.forecast, patch);
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'forecast_unavailable_or_stale',
  });
});

test.each([
  { receivedAt: NOW + 1 },
  { requestedAt: NOW + 1 },
  { receivedAt: NOW - 15001, requestedAt: NOW - 15001 },
  { ticker: 'KXBTC15M-WRONG' },
  { yesAsks: [{ price: 0.3, quantity: 100 }], noAsks: [{ price: 0.4, quantity: 100 }] },
  { yesAsks: [{ price: 0.5, quantity: -1 }] },
])('waits for a causal matching book %p', (patch) => {
  const value = input();
  Object.assign(value.book, patch);
  expect(getTradingAdvice(value).action).toBe('wait');
});

test('does not recommend an action with unknown or stale fees', () => {
  const value = withPosition();
  value.book.fee.checkedAt = NOW - 30001;
  expect(getTradingAdvice(value)).toMatchObject({ action: 'wait', reason: 'fees_unavailable' });
});

test('does not trade at or after the exact contract deadline', () => {
  const value = input();
  value.now = contract.expiresAt;
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'outside_active_contract',
  });
});

test('uses the held-side bid and subtracts fees when comparing sale with holding', () => {
  const value = withPosition();
  const advice = getTradingAdvice(value);
  const quote = getTradingExecutionQuote({ action: 'sell', side: 'yes', quantity: 10, ...value });
  expect(advice).toMatchObject({
    action: 'sell',
    side: 'yes',
    quantity: 10,
    positionId: 'position-1',
  });
  expect(quote.averagePrice).toBeCloseTo(1 - 0.55 - 0.01);
  expect(advice.expectedProceeds).toBeLessThan(4.4);
  expect(advice.holdExpectedValue).toBe(3);
  expect(advice.limitPrice * 100).toBeCloseTo(Math.round(advice.limitPrice * 100), 10);
  expect(advice.expectedNetValue).toBeCloseTo(advice.expectedProceeds - 3);
});

test('entry price is sunk cost: a losing position can be worth selling', () => {
  const value = withPosition();
  const before = getTradingAdvice(value);
  value.portfolio.positions[0].costBasis = 9;
  value.portfolio.positions[0].entryFees = 1;
  value.portfolio.positions[0].averagePrice = 0.8;
  expect(getTradingAdvice(value)).toEqual(before);
  expect(before.action).toBe('sell');
});

test('manages existing positions even when new entries are blocked by daily loss', () => {
  const value = withPosition();
  value.portfolio.dailyRealizedPnl = -10;
  expect(getTradingAdvice(value).action).toBe('sell');
});

test('reduces only the quantity supported by executable depth', () => {
  const value = withPosition();
  value.book.noAsks = [{ price: 0.55, quantity: 3.5 }];
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'sell',
    quantity: 3,
    reason: 'reduce_at_better_than_hold_value',
  });
});

test('respects quantity already reserved for other sells', () => {
  const value = withPosition();
  value.portfolio.positions[0].availableQuantity = 2;
  expect(getTradingAdvice(value).quantity).toBe(2);
  value.portfolio.positions[0].availableQuantity = 0;
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'position_already_reserved',
  });
});

test('holds a valuable position without adding another purchase in the same event', () => {
  const value = withPosition(0.85);
  const advice = getTradingAdvice(value);
  expect(advice).toMatchObject({ action: 'hold', side: 'yes', quantity: 10 });
  expect(advice.exitPlan.limitPrice).toBeGreaterThan(0.91);
  expect(advice.holdExpectedValue).toBe(8.5);
});

test('does not propose an impossible exit target above the contract payout', () => {
  const value = withPosition(0.99);
  expect(getTradingAdvice(value)).toMatchObject({ action: 'hold', exitPlan: null });
});

test('empty sell depth is Wait instead of a confident Hold', () => {
  const value = withPosition();
  value.book.noAsks = [];
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'insufficient_exit_depth',
  });
});

test('a held contract with a changed target is not managed as the matching event', () => {
  const value = withPosition();
  value.portfolio.positions[0].contract = { ...contract, target: 76000 };
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'position_contract_mismatch',
  });
});

test('delayed simulated buy stays within the saved limit and reserved amount', () => {
  const advice = getTradingAdvice(input());
  const fill = execute(advice);
  expect(fill).toMatchObject({ kind: 'fill', action: 'buy', quantity: advice.quantity });
  expect(fill.totalCost).toBeLessThanOrEqual(advice.maxCost);
  expect(fill.price).toBe(0.51);
  expect(Object.isFrozen(fill.book)).toBe(true);
});

test('does not execute before the observation delay or after its deadline', () => {
  const advice = getTradingAdvice(input());
  expect(execute(advice, input(), { now: NOW + 1999 })).toBeNull();
  expect(execute(advice, input(), { now: NOW + 15001 })).toMatchObject({
    kind: 'no-fill',
    reason: 'execution_window_expired',
  });
});

test('does not reuse an initial or unproven execution book', () => {
  const advice = getTradingAdvice(input());
  expect(execute(advice, input(), { book: bookAt() })).toMatchObject({
    kind: 'no-fill',
    reason: 'no_causal_execution_book',
  });
  const book = bookAt(NOW + 2000);
  delete book.requestedAt;
  expect(execute(advice, input(), { book })).toMatchObject({
    kind: 'no-fill',
    reason: 'no_causal_execution_book',
  });
});

test('changed prices cannot spend beyond the frozen entry limit', () => {
  const advice = getTradingAdvice(input());
  const book = bookAt(NOW + 2000);
  book.yesAsks = [{ price: 0.8, quantity: 100 }];
  expect(execute(advice, input(), { book })).toMatchObject({
    kind: 'no-fill',
    reason: 'limit_price_exceeded',
  });
});

test('a later fee increase cannot spend more than the saved reservation', () => {
  const advice = getTradingAdvice(input());
  const book = bookAt(NOW + 2000);
  book.fee.multiplier = 10;
  expect(execute(advice, input(), { book })).toMatchObject({
    kind: 'no-fill',
    reason: 'reserved_capital_exceeded',
  });
});

test('sell simulation requires a held matching position with sufficient unreserved quantity', () => {
  const value = withPosition();
  const advice = getTradingAdvice(value);
  expect(execute(advice, value)).toMatchObject({ kind: 'fill', action: 'sell', quantity: 10 });
  value.portfolio.positions[0].availableQuantity = 9;
  expect(execute(advice, value)).toMatchObject({ kind: 'no-fill', reason: 'position_unavailable' });
  expect(execute(advice, input())).toMatchObject({
    kind: 'no-fill',
    reason: 'position_unavailable',
  });
});

test('sell simulation does not accept a poorer bid than the minimum exit limit', () => {
  const value = withPosition();
  const advice = getTradingAdvice(value);
  const book = bookAt(NOW + 2000);
  book.noAsks = [{ price: 0.75, quantity: 100 }];
  expect(execute(advice, value, { book })).toMatchObject({
    kind: 'no-fill',
    reason: 'limit_price_exceeded',
  });
});

test('refreshed sell fees must preserve the saved net advantage, even with an unchanged bid', () => {
  const value = withPosition();
  const advice = getTradingAdvice(value);
  expect(advice.minimumNetProceeds).toBe(3.6);
  const book = bookAt(NOW + 2000);
  book.fee.multiplier = 10;
  expect(execute(advice, value, { book })).toMatchObject({
    kind: 'no-fill',
    reason: 'execution_edge_lost',
  });
});

test('an unsupported extreme fee schedule waits rather than using a nonmonotone price search', () => {
  const value = input();
  value.book.fee.multiplier = 100;
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'unsupported_fee_schedule',
  });
});

test('pending execution suppresses another decision for the same event', () => {
  const value = withPosition();
  value.portfolio.pendingIntents = [{ contract }];
  expect(getTradingAdvice(value)).toMatchObject({ action: 'wait', reason: 'pending_execution' });
});

test('buys stop during the last thirty seconds while sells remain available', () => {
  const value = input();
  value.now = contract.expiresAt - 30000;
  value.forecast.capturedAt = value.now;
  value.book = bookAt(value.now);
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'too_close_to_settlement',
  });
  const held = withPosition();
  held.now = value.now;
  held.forecast.capturedAt = value.now;
  held.book = value.book;
  expect(getTradingAdvice(held).action).toBe('sell');
});

test('a delayed buy cannot cross into the last thirty seconds', () => {
  const value = input();
  value.now = contract.expiresAt - 31000;
  value.forecast.capturedAt = value.now;
  value.book = bookAt(value.now);
  const advice = getTradingAdvice(value);
  expect(advice.action).toBe('buy');
  expect(
    execute(advice, value, { now: value.now + 2000, book: bookAt(value.now + 2000) }),
  ).toMatchObject({ kind: 'no-fill', reason: 'too_close_to_settlement' });
});

test.each([
  [{ cash: 50 }, 'capital_limit_changed'],
  [{ openRisk: 20 }, 'capital_limit_changed'],
  [{ dailyRealizedPnl: -5 }, 'daily_loss_limit'],
])('new losses or commitments cannot bypass execution risk limits: %p', (patch, reason) => {
  const value = input();
  const advice = getTradingAdvice(value);
  Object.assign(value.portfolio, patch);
  expect(execute(advice, value)).toMatchObject({ kind: 'no-fill', reason });
});

test('an already opened event position cannot be doubled by a delayed buy', () => {
  const advice = getTradingAdvice(input());
  const value = withPosition();
  expect(execute(advice, value)).toMatchObject({
    kind: 'no-fill',
    reason: 'position_already_open',
  });
});

test('a hold exposes the sale and settlement values for the same available quantity', () => {
  const advice = getTradingAdvice(withPosition(0.85));
  expect(advice).toMatchObject({ action: 'hold', quantity: 10, holdExpectedValue: 8.5 });
  expect(advice.expectedProceeds).toBeGreaterThan(4);
  expect(advice.expectedProceeds).toBeLessThan(4.4);
  expect(advice.quotedFee).toBeGreaterThan(0);
});

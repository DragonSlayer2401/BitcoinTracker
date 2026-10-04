/** @jest-environment node */
import { createAdvisorPlan, getAdvisorPlanState } from '../utils/advisorPlan.utils';

const NOW = Date.UTC(2026, 9, 3, 12, 5);
const market = {
  ticker: 'BTC-ONE',
  target: 80000,
  startsAt: NOW - 300000,
  expiresAt: NOW + 600000,
};
const buy = {
  id: 'buy-1',
  contract: market,
  action: 'buy',
  side: 'yes',
  quantity: 5,
  limitPrice: 0.55,
  maxCost: 2.9,
  reason: 'fee_adjusted_entry_edge',
  evaluatedAt: NOW,
  validUntil: NOW + 15000,
  accountVersion: 3,
};
const hold = { ...buy, id: 'hold-1', action: 'hold', reason: 'hold_value_exceeds_sale' };
const reportFor = (advice = buy) => ({
  startedAt: NOW - 60000,
  asOf: NOW,
  collector: { status: 'running', heartbeatAt: NOW },
  latestAdvice: advice,
  portfolio: { positions: [], pendingIntents: [] },
  recentActivity: [],
});
const inspect = (report, options = {}) =>
  getAdvisorPlanState({ report, market, now: NOW + 1000, ...options });

test('persists only compact numerical display evidence and retains the original review boundary', () => {
  const plan = createAdvisorPlan({
    ...buy,
    book: { secret: 'not-a-display-field' },
    forecast: { inputs: [] },
  });
  expect(plan).toMatchObject({
    adviceId: buy.id,
    action: 'buy',
    assessedAt: NOW,
    validUntil: NOW + 15000,
    reviewAt: NOW + 15000,
  });
  expect(plan.advice.limitPrice).toBe(0.55);
  expect(plan.advice.book).toBeUndefined();
  expect(plan.advice.forecast).toBeUndefined();
  expect(plan.conditions[0]).toContain('$0.55');
});

test('a fresh HOLD remains the plan through cooldown rather than becoming unexplained WAIT', () => {
  const plan = createAdvisorPlan(hold);
  const waiting = {
    ...hold,
    id: 'waiting',
    evaluatedAt: NOW + 1000,
    action: 'wait',
    reason: 'reentry_cooldown',
  };
  expect(createAdvisorPlan(waiting, plan)).toBe(plan);
  const state = inspect({ ...reportFor(waiting), currentPlan: plan });
  expect(state.heading).toBe('HOLD UP');
  expect(state.readiness).toBe('cooldown');
  expect(state.blocker).toContain('last sale');
  expect(state.current.assessedAt).toBe(NOW);
  expect(state.current.validUntil).toBe(NOW + 15000);
});

test('a valid conditional entry states the real threshold while waiting for a fresh quote', () => {
  const plan = createAdvisorPlan(buy);
  const waiting = { ...buy, id: 'quote-wait', action: 'wait', reason: 'book_unavailable_or_stale' };
  const state = inspect({ ...reportFor(waiting), currentPlan: plan });
  expect(state.current.action).toBe('conditional-buy');
  expect(state.current.conditions[0]).toContain('$0.55');
  expect(state.readinessLabel).toBe('Awaiting fresh quote');
});

test('a pending order retains its plan without suggesting execution is ready', () => {
  const state = inspect({
    ...reportFor(buy),
    portfolio: { positions: [], pendingIntents: [{ id: buy.id }] },
  });
  expect(state.heading).toBe('BUY UP');
  expect(state.readiness).toBe('pending');
});

test.each(['filled', 'no-fill'])(
  'a consumed %s order is historical until a new position assessment arrives',
  (executionStatus) => {
    const state = inspect(reportFor({ ...buy, executionStatus }));
    expect(state.current).toBeNull();
    expect(state.heading).toBe('Assessment unavailable');
    expect(state.historical.adviceId).toBe(buy.id);
    expect(state.readiness).toBe(executionStatus === 'filled' ? 'filled' : 'canceled');
  },
);

test('a partial fill consumes the whole old intention, including its canceled remainder', () => {
  const state = inspect({
    ...reportFor(),
    recentActivity: [
      { adviceId: buy.id, kind: 'fill', quantity: 2, canceledQuantity: 3, recordedAt: NOW + 500 },
    ],
  });
  expect(state.current).toBeNull();
  expect(state.readiness).toBe('filled');
  expect(state.completedFill.quantity).toBe(2);
});

test('a later fresh HOLD replaces a filled entry rather than repeating its BUY instruction', () => {
  const state = inspect({
    ...reportFor(hold),
    currentPlan: createAdvisorPlan(hold),
    recentActivity: [{ adviceId: buy.id, kind: 'fill', recordedAt: NOW - 1000 }],
    portfolio: { positions: [{ entryAdviceId: buy.id, quantity: 5 }], pendingIntents: [] },
  });
  expect(state.heading).toBe('HOLD UP');
  expect(state.readiness).toBe('ready');
});

test.each([
  ['expired', { now: NOW + 15000 }],
  ['changed target', { market: { ...market, target: 80001 } }],
  ['changed event', { market: { ...market, ticker: 'BTC-TWO' } }],
  ['failed refresh', { isError: true }],
])('%s evidence becomes historical rather than a current instruction', (_label, options) => {
  const state = inspect(reportFor(), options);
  expect(state.current).toBeNull();
  expect(state.historical.adviceId).toBe(buy.id);
  expect(state.readiness).toBe('stale');
});

test('a changed account version invalidates an otherwise fresh persisted plan', () => {
  const state = inspect({
    ...reportFor(),
    currentPlan: { ...createAdvisorPlan(buy), accountVersion: 4 },
    portfolio: { accountVersion: 5, positions: [], pendingIntents: [] },
  });
  expect(state.current).toBeNull();
  expect(state.readiness).toBe('stale');
});

test('a closed event is explicit and cannot retain an actionable entry', () => {
  const state = inspect(reportFor(), { now: market.expiresAt });
  expect(state.current).toBeNull();
  expect(state.readiness).toBe('closed');
});

test('true no-trade decisions remain explicit instead of being mistaken for a data problem', () => {
  const state = inspect(
    reportFor({ ...buy, action: 'wait', side: null, reason: 'insufficient_entry_edge_or_depth' }),
  );
  expect(state.heading).toBe('NO TRADE');
  expect(state.readiness).toBe('ready');
  expect(state.explanation).toContain('No suitable entry');
});

test.each([
  ['reduce_at_better_than_hold_value', 'REDUCE UP'],
  ['sale_better_than_hold_value', 'EXIT UP'],
])('distinguishes %s without changing any quantity or limit', (reason, heading) => {
  const state = inspect(reportFor({ ...buy, action: 'sell', reason }));
  expect(state.heading).toBe(heading);
  expect(state.advice.quantity).toBe(buy.quantity);
  expect(state.advice.limitPrice).toBe(buy.limitPrice);
});

test('routine status updates cannot revive an expired plan or move it to a different target', () => {
  const previous = createAdvisorPlan(hold);
  const waiting = {
    ...hold,
    id: 'next',
    action: 'wait',
    reason: 'pending_execution',
    evaluatedAt: NOW + 15000,
    validUntil: NOW + 30000,
  };
  expect(createAdvisorPlan(waiting, previous).action).toBe('unavailable');
  expect(
    createAdvisorPlan(
      { ...waiting, evaluatedAt: NOW + 1000, contract: { ...market, target: 1 } },
      previous,
    ).action,
  ).toBe('unavailable');
  expect(previous.validUntil).toBe(NOW + 15000);
});

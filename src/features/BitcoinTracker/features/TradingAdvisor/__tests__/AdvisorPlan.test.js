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
  'a consumed %s order shows its result without repeating the order',
  (executionStatus) => {
    const state = inspect(reportFor({ ...buy, executionStatus }));
    expect(state.current).toBeNull();
    expect(state.heading).toBe(executionStatus === 'filled' ? 'UP PURCHASED' : 'ORDER NOT FILLED');
    expect(state.active).toBeNull();
    expect(state.advice).toBeNull();
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
  ['failed refresh', { isError: true }],
  ['loading refresh', { isLoading: true }],
  ['missing market refresh', { market: null }],
])('%s quotes do not revoke the same-event plan or renew order permissions', (_label, options) => {
  const state = inspect(reportFor(), options);
  expect(state.current).toBeNull();
  expect(state.active.adviceId).toBe(buy.id);
  expect(state.active.validUntil).toBe(NOW + 15000);
  expect(state.historical).toBeNull();
  expect(state.lifecycle).toBe('active');
  expect(state.executionReady).toBe(false);
  expect(state.heading).toBe('BUY UP');
  expect(state.displayed.assessedAt).toBe(NOW);
  expect(state.advice).toBeNull();
  expect(state.updateMessage).toMatch(/plan/i);
});

test.each([
  ['changed target', { market: { ...market, target: 80001 } }],
  ['changed event', { market: { ...market, ticker: 'BTC-TWO' } }],
  ['changed deadline', { market: { ...market, expiresAt: NOW + 900000 } }],
])('%s starts a new review instead of applying the previous instruction', (_label, options) => {
  const state = inspect(reportFor(), options);
  expect(state.current).toBeNull();
  expect(state.active).toBeNull();
  expect(state.historical.adviceId).toBe(buy.id);
  expect(state.heading).toBe('REVIEWING NEW EVENT');
  expect(state.displayed.assessedAt).toBe(NOW);
  expect(state.advice).toBeNull();
  expect(state.readiness).toBe('stale');
});

test('bookkeeping versions require order revalidation but do not change the plan', () => {
  const state = inspect({
    ...reportFor(),
    currentPlan: { ...createAdvisorPlan(buy), accountVersion: 4 },
    portfolio: { accountVersion: 5, positions: [], pendingIntents: [] },
  });
  expect(state.current).toBeNull();
  expect(state.active.adviceId).toBe(buy.id);
  expect(state.heading).toBe('BUY UP');
  expect(state.readiness).toBe('stale');
});

test('a closed event is explicit and cannot retain an actionable entry', () => {
  const state = inspect(reportFor(), { now: market.expiresAt });
  expect(state.current).toBeNull();
  expect(state.active).toBeNull();
  expect(state.heading).toBe('EVENT ENDED');
  expect(state.readiness).toBe('closed');
});

test('true no-trade decisions remain explicit instead of being mistaken for a data problem', () => {
  const state = inspect(
    reportFor({ ...buy, action: 'wait', side: null, reason: 'insufficient_entry_edge' }),
  );
  expect(state.heading).toBe('NO TRADE');
  expect(state.readiness).toBe('ready');
  expect(state.explanation).toContain('Insufficient edge');
});

test.each([
  ['reduce_at_better_than_hold_value', 'REDUCE UP'],
  ['candidate_reduce_thesis', 'REDUCE UP'],
  ['sale_better_than_hold_value', 'EXIT UP'],
  ['candidate_exit_thesis', 'EXIT UP'],
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
  expect(createAdvisorPlan(waiting, previous)).toBe(previous);
  expect(
    createAdvisorPlan(
      { ...waiting, evaluatedAt: NOW + 1000, contract: { ...market, target: 1 } },
      previous,
    ),
  ).toBe(previous);
  expect(previous.validUntil).toBe(NOW + 15000);
});

test('operational waiting across an event rollover keeps the old event only in history', () => {
  const nextMarket = { ...market, ticker: 'BTC-TWO', target: 81000 };
  const previous = createAdvisorPlan(hold);
  const waiting = {
    ...buy,
    contract: nextMarket,
    action: 'wait',
    reason: 'forecast_unavailable_or_stale',
  };
  const state = inspect(
    { ...reportFor(waiting), currentPlan: createAdvisorPlan(waiting, previous) },
    { market: nextMarket },
  );
  expect(state.heading).toBe('REVIEWING NEW EVENT');
  expect(state.previousEvent).toBe(true);
  expect(state.displayed.contract).toEqual(market);
  expect(state.current).toBeNull();
  expect(state.advice).toBeNull();
});

test('a real no-trade assessment replaces an old HOLD while routine waits do not', () => {
  const previous = createAdvisorPlan(hold);
  const next = createAdvisorPlan(
    {
      ...buy,
      id: 'no-trade',
      evaluatedAt: NOW + 20000,
      action: 'wait',
      reason: 'insufficient_entry_edge_or_depth',
    },
    previous,
  );
  expect(next.action).toBe('no-trade');
  expect(next.adviceId).toBe('no-trade');
  expect(next.assessedAt).toBe(NOW + 20000);
});

test('recovery never renews order permissions and changed policies start a new plan review', () => {
  for (const extra of [{ historicalOnly: true }, { policyId: 'old-policy' }]) {
    const state = inspect({
      ...reportFor(),
      policy: { id: 'new-policy' },
      currentPlan: { ...createAdvisorPlan(buy), ...extra },
    });
    expect(state.heading).toBe(extra.policyId ? 'REVIEWING ACCOUNT' : 'BUY UP');
    expect(Boolean(state.active)).toBe(!extra.policyId);
    expect(state.current).toBeNull();
    expect(state.advice).toBeNull();
  }
});

test('the initial operational wait does not pretend that a meaningful assessment exists', () => {
  const state = inspect(reportFor({ ...buy, action: 'wait', reason: 'book_unavailable_or_stale' }));
  expect(state.heading).toBe('Awaiting first assessment');
  expect(state.displayed).toBeNull();
  expect(state.assessedAt).toBeNull();
});

test('the same HOLD plan survives several AI refresh intervals without extending its evidence', () => {
  const original = createAdvisorPlan(hold);
  const report = {
    ...reportFor({ ...hold, action: 'wait', reason: 'forecast_unavailable_or_stale' }),
    currentPlan: { ...original, accountVersion: 3 },
    portfolio: { accountVersion: 9, positions: [], pendingIntents: [] },
  };
  for (const elapsed of [15000, 30000, 60000, 180000]) {
    const state = inspect(report, { now: NOW + elapsed });
    expect(state.heading).toBe('HOLD UP');
    expect(state.active).toMatchObject({ assessedAt: NOW, validUntil: NOW + 15000 });
    expect(state.advice).toBeNull();
    expect(state.executionReady).toBe(false);
    expect(state.historical).toBeNull();
  }
});

test.each([
  ['closed', []],
  ['reduced', [{ id: 'position-1', side: 'yes', quantity: 2 }]],
  ['changed side', [{ id: 'position-1', side: 'no', quantity: 5 }]],
])(
  'a %s position ends its prior plan instead of preserving a misleading instruction',
  (_, positions) => {
    const state = inspect({
      ...reportFor({ ...hold, positionId: 'position-1' }),
      portfolio: { positions, pendingIntents: [] },
    });
    expect(state.active).toBeNull();
    expect(state.current).toBeNull();
    expect(state.heading).toBe('REVIEWING ACCOUNT');
  },
);

test('an unchanged known position retains HOLD despite an operational account-version increment', () => {
  const state = inspect({
    ...reportFor({ ...hold, positionId: 'position-1' }),
    portfolio: {
      accountVersion: 4,
      positions: [{ id: 'position-1', side: 'yes', quantity: 5 }],
      pendingIntents: [],
    },
  });
  expect(state.heading).toBe('HOLD UP');
  expect(state.active.adviceId).toBe(hold.id);
  expect(state.current).toBeNull();
});

test.each([
  ['reduce_at_better_than_hold_value', 'UP REDUCED'],
  ['candidate_reduce_thesis', 'UP REDUCED'],
  ['sale_better_than_hold_value', 'UP SOLD'],
])(
  'a completed %s sale displays the result instead of telling the user to sell again',
  (reason, heading) => {
    const state = inspect(reportFor({ ...buy, action: 'sell', reason, executionStatus: 'filled' }));
    expect(state.heading).toBe(heading);
    expect(state.active).toBeNull();
    expect(state.current).toBeNull();
  },
);

test('saved legacy expiry wording is normalized for the current plan without rewriting evidence', () => {
  const plan = createAdvisorPlan(hold);
  plan.invalidationConditions = [
    'This assessment expires when its evidence becomes stale or this event closes.',
  ];
  const state = inspect({ ...reportFor(hold), currentPlan: plan }, { now: NOW + 60000 });
  expect(state.active.invalidationConditions[0]).toContain('Keep this plan');
  expect(plan.invalidationConditions[0]).toContain('assessment expires');
  expect(state.active.validUntil).toBe(plan.validUntil);
});

test('a future-dated plan cannot become the current instruction', () => {
  const state = inspect(reportFor({ ...buy, evaluatedAt: NOW + 10000 }));
  expect(state.active).toBeNull();
  expect(state.current).toBeNull();
  expect(state.heading).toBe('Awaiting first assessment');
});

test('unusable collector timestamps report interrupted updates while preserving the plan', () => {
  const state = inspect({
    ...reportFor(hold),
    collector: { status: 'running', heartbeatAt: NOW + 10000 },
  });
  expect(state.heading).toBe('HOLD UP');
  expect(state.current).toBeNull();
  expect(state.updateMessage).toBe('Updates interrupted · keeping the current plan');
});

test('an event ends at its saved deadline even if market updates are unavailable', () => {
  const state = inspect(reportFor(hold), { market: null, now: market.expiresAt, isError: true });
  expect(state.active).toBeNull();
  expect(state.current).toBeNull();
  expect(state.heading).toBe('EVENT ENDED');
});

/** @jest-environment node */
import {
  PAPER_TRADING_POLICY,
  createPaperDecision,
  simulatePaperFill,
  settlePaperPosition,
  getPaperPortfolio,
  getPaperTradingReport,
  isPaperDecision,
  isPaperExecutionEvent,
  isPaperSettlementEvent,
} from '../utils/paperTrading.utils';
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
const makeBook = (now = NOW) => ({
  ticker: contract.ticker,
  receivedAt: now,
  requestedAt: now,
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
const makeInput = () => ({
  contract,
  now: NOW,
  forecast: {
    available: true,
    aboveProbability: 0.85,
    capturedAt: NOW,
    modelVersion: 'kalshi-brti-average-v1',
    modelId: null,
  },
  book: makeBook(),
  portfolio: { cash: 100, openRisk: 0, dailyRealizedPnl: 0 },
});
const makeDecision = () => createPaperDecision(makeInput());
const makeFill = (decision = makeDecision(), book = makeBook(NOW + 2000)) =>
  simulatePaperFill({ decision, book, now: NOW + 2000 });
const makeMarket = (result = 'yes') => ({
  ...contract,
  status: 'settled',
  result,
  settlementPrice: 75001,
  receivedAt: contract.expiresAt + 5000,
  settledAt: contract.expiresAt + 4000,
});
const makeSettlement = (decision, fill, result = 'yes') =>
  settlePaperPosition({
    decision,
    fill,
    market: makeMarket(result),
    now: contract.expiresAt + 5000,
  });

test('records an immutable fee-inclusive decision with explicit probability and slippage reserves', () => {
  const input = makeInput();
  const decision = createPaperDecision(input);
  expect(decision).toMatchObject({
    id: `${PAPER_TRADING_POLICY.id}:${contract.ticker}`,
    status: 'intent',
    side: 'yes',
    quantity: 1,
  });
  expect(decision.expectedNetValue).toBeCloseTo(0.85 - 0.51 - 0.0175);
  expect(decision.conservativeExpectedNetValue).toBeCloseTo(decision.expectedNetValue - 0.05);
  expect(decision.reservedCapital).toBeLessThanOrEqual(0.8 - 0.03 + 1e-8);
  expect(decision.reservedCapital).toBeGreaterThan(0.52);
  expect(decision.maxCost).toBe(decision.reservedCapital);
  expect(Object.isFrozen(decision.book.yesAsks)).toBe(true);
  input.book.yesAsks[0].price = 0.9;
  expect(decision.book.yesAsks[0].price).toBe(0.5);
  expect(isPaperDecision(decision)).toBe(true);
});

test('can prefer buying No using its complementary probability', () => {
  const input = makeInput();
  input.forecast.aboveProbability = 0.15;
  const decision = createPaperDecision(input);
  expect(decision.side).toBe('no');
  expect(decision.conservativeExpectedNetValue).toBeGreaterThan(0.2);
});

test.each([-1, 5001])(
  'captures a skip rather than moving the six-minute decision window by %ims',
  (offset) => {
    const input = makeInput();
    input.now += offset;
    expect(createPaperDecision(input).reason).toBe('outside_capture_window');
  },
);

test.each([
  { available: false },
  { aboveProbability: NaN },
  { aboveProbability: 1.1 },
  { capturedAt: NOW + 1 },
  { capturedAt: NOW - 5001 },
  { modelVersion: null },
])('records a skip for unusable or future model input %p', (patch) => {
  const input = makeInput();
  Object.assign(input.forecast, patch);
  const decision = createPaperDecision(input);
  expect(decision.status).toBe('skipped');
  expect(decision.reason).toBe('forecast_unavailable_or_stale');
  expect(isPaperDecision(decision)).toBe(true);
});

test.each([
  { receivedAt: NOW + 1 },
  { requestedAt: NOW + 1 },
  { receivedAt: NOW - 15001, requestedAt: NOW - 15001 },
  { ticker: 'KXBTC15M-OTHER' },
])('does not buy using a noncausal, stale, or mismatched book %p', (patch) => {
  const input = makeInput();
  Object.assign(input.book, patch);
  expect(createPaperDecision(input).status).toBe('skipped');
});

test('does not double-count spread or use the current-side flip chance as another penalty', () => {
  const first = makeDecision();
  const input = makeInput();
  input.forecast.currentSideFlipProbability = 0.99;
  input.book.noAsks = [{ price: 0.99, quantity: 100 }];
  const second = createPaperDecision(input);
  expect(second.expectedNetValue).toBe(first.expectedNetValue);
  expect(second.conservativeExpectedNetValue).toBe(first.conservativeExpectedNetValue);
});

test.each([
  [{ cash: 0.1 }, 'insufficient_cash'],
  [{ openRisk: 4.8 }, 'open_risk_limit'],
  [{ dailyRealizedPnl: -5 }, 'daily_loss_limit'],
  [{ cash: NaN }, 'portfolio_unavailable'],
])('respects available capital and realized daily loss %p', (patch, reason) => {
  const input = makeInput();
  Object.assign(input.portfolio, patch);
  expect(createPaperDecision(input)).toMatchObject({
    status: 'skipped',
    reason,
    reservedCapital: 0,
  });
});

test('records skips for missing fees, weak edge, and incomplete one-contract depth', () => {
  const noFees = makeInput();
  noFees.book.fee.available = false;
  expect(createPaperDecision(noFees).reason).toBe('fees_unavailable');
  const weak = makeInput();
  weak.forecast.aboveProbability = 0.54;
  expect(createPaperDecision(weak).status).toBe('skipped');
  const shallow = makeInput();
  shallow.book.yesAsks[0].quantity = 0.5;
  expect(createPaperDecision(shallow).status).toBe('skipped');
});

test('rejects crossed books instead of recording a false simultaneous bargain', () => {
  const input = makeInput();
  input.book.noAsks[0].price = 0.4;
  expect(createPaperDecision(input)).toMatchObject({
    status: 'skipped',
    reason: 'book_unavailable_or_stale',
  });
  const book = makeBook(NOW + 2000);
  book.noAsks[0].price = 0.4;
  expect(makeFill(makeDecision(), book)).toMatchObject({
    kind: 'no-fill',
    reason: 'execution_book_unavailable',
  });
});

test('walks fractional displayed depth without partial paper positions', () => {
  const input = makeInput();
  input.book.yesAsks = [
    { price: 0.5, quantity: 0.4 },
    { price: 0.6, quantity: 0.6 },
  ];
  const decision = createPaperDecision(input);
  const book = { ...input.book, receivedAt: NOW + 2000, requestedAt: NOW + 2000 };
  const fill = makeFill(decision, book);
  expect(fill).toMatchObject({ kind: 'fill', quantity: 1, cost: 0.57 });
  expect(fill.fills).toHaveLength(2);
});

test('requires a delayed new request and new book before a fill', () => {
  const decision = makeDecision();
  expect(simulatePaperFill({ decision, book: makeBook(NOW + 1999), now: NOW + 1999 })).toBeNull();
  expect(simulatePaperFill({ decision, book: makeBook(), now: NOW + 2000 }).kind).toBe('no-fill');
  expect(
    simulatePaperFill({
      decision,
      book: { ...makeBook(NOW + 2000), requestedAt: NOW + 1000 },
      now: NOW + 2000,
    }),
  ).toMatchObject({ kind: 'no-fill', reason: 'no_causal_execution_book' });
  const fill = makeFill(decision);
  expect(fill).toMatchObject({
    kind: 'fill',
    quantity: 1,
    price: 0.51,
    cost: 0.51,
    fee: 0.0175,
    totalCost: 0.5275,
  });
  expect(fill.book.receivedAt).toBe(NOW + 2000);
  expect(isPaperExecutionEvent(fill, decision)).toBe(true);
});

test('expires missing execution data and rejects requests finishing after the execution window', () => {
  const decision = makeDecision();
  const missing = simulatePaperFill({ decision, book: null, now: NOW + 15000 });
  expect(missing).toMatchObject({
    kind: 'no-fill',
    quantity: 0,
    reason: 'no_causal_execution_book',
  });
  expect(isPaperExecutionEvent(missing, decision)).toBe(true);
  const late = simulatePaperFill({ decision, book: makeBook(NOW + 15001), now: NOW + 15001 });
  expect(late).toMatchObject({ kind: 'no-fill', reason: 'execution_window_expired' });
});

test('applies adverse slippage to the limit and never fills partial depth', () => {
  const decision = makeDecision();
  const limitBook = makeBook(NOW + 2000);
  limitBook.yesAsks[0].price = decision.limitPrice;
  expect(makeFill(decision, limitBook)).toMatchObject({
    kind: 'no-fill',
    reason: 'limit_price_exceeded',
  });
  const shallow = makeBook(NOW + 2000);
  shallow.yesAsks[0].quantity = 0.99;
  expect(makeFill(decision, shallow)).toMatchObject({
    kind: 'no-fill',
    reason: 'insufficient_execution_depth',
  });
});

test('refreshes fees and cannot spend more than reserved capital', () => {
  const decision = makeDecision();
  const book = makeBook(NOW + 2000);
  book.fee.multiplier = 20;
  expect(makeFill(decision, book)).toMatchObject({
    kind: 'no-fill',
    reason: 'reserved_capital_exceeded',
  });
  book.fee.available = false;
  expect(makeFill(decision, book)).toMatchObject({
    kind: 'no-fill',
    reason: 'execution_fees_unavailable',
  });
});

test('scores only the exact official settled contract and stores proof', () => {
  const decision = makeDecision();
  const fill = makeFill(decision);
  const now = contract.expiresAt + 5000;
  expect(
    settlePaperPosition({ decision, fill, market: { ...makeMarket(), status: 'closed' }, now }),
  ).toBeNull();
  expect(
    settlePaperPosition({ decision, fill, market: { ...makeMarket(), target: 75001 }, now }),
  ).toBeNull();
  expect(
    settlePaperPosition({ decision, fill, market: { ...makeMarket(), receivedAt: now + 1 }, now }),
  ).toBeNull();
  const settlement = makeSettlement(decision, fill);
  expect(settlement).toMatchObject({
    kind: 'settlement',
    outcome: 'yes',
    payout: 1,
    netPnl: 0.4725,
    totalCost: 0.5275,
  });
  expect(settlement.kalshiOutcome.marketTicker).toBe(contract.ticker);
  expect(isPaperSettlementEvent(settlement, decision, fill)).toBe(true);
  // The official result remains authoritative even if a provided print would suggest otherwise.
  expect(makeSettlement(decision, fill, 'no').netPnl).toBe(-0.5275);
});

test('rejects tampered decision, execution, and settlement amounts', () => {
  const decision = makeDecision();
  const fill = makeFill(decision);
  expect(isPaperDecision({ ...decision, reservedCapital: 0.01 })).toBe(false);
  expect(isPaperExecutionEvent({ ...fill, cost: 0.01 }, decision)).toBe(false);
  const settlement = makeSettlement(decision, fill);
  expect(isPaperSettlementEvent({ ...settlement, netPnl: 100 }, decision, fill)).toBe(false);
});

test('reserves intent capital, charges only filled cost, and credits settlement exactly once', () => {
  const decision = makeDecision();
  const fill = makeFill(decision);
  const settlement = makeSettlement(decision, fill);
  const pending = getPaperPortfolio({ decisions: [decision, decision], events: [], now: NOW });
  expect(pending).toMatchObject({
    pendingIntentCount: 1,
    reservedCapital: decision.reservedCapital,
    openRisk: decision.reservedCapital,
  });
  expect(pending.cash).toBeCloseTo(100 - decision.reservedCapital);
  const open = getPaperPortfolio({ decisions: [decision], events: [fill, fill], now: NOW + 2000 });
  expect(open).toMatchObject({
    cash: 99.4725,
    openRisk: 0.5275,
    reservedCapital: 0,
    openPositionCount: 1,
  });
  const settled = getPaperPortfolio({
    decisions: [decision],
    events: [fill, fill, settlement, settlement],
    now: contract.expiresAt + 5000,
  });
  expect(settled).toMatchObject({
    cash: 100.4725,
    realizedPnl: 0.4725,
    dailyRealizedPnl: 0.4725,
    openRisk: 0,
    settledCount: 1,
  });
});

test('releases no-fill reservations, excludes future events, and fails closed on malformed events', () => {
  const decision = makeDecision();
  const noFill = simulatePaperFill({ decision, book: null, now: NOW + 15000 });
  expect(
    getPaperPortfolio({ decisions: [decision], events: [noFill], now: NOW + 14999 })
      .pendingIntentCount,
  ).toBe(1);
  const portfolio = getPaperPortfolio({
    decisions: [decision],
    events: [noFill],
    now: NOW + 15000,
  });
  expect(portfolio).toMatchObject({ cash: 100, openRisk: 0, reservedCapital: 0, realizedPnl: 0 });
  const fake = { ...makeFill(decision), totalCost: 0 };
  expect(() =>
    getPaperPortfolio({ decisions: [decision], events: [fake], now: NOW + 2000 }),
  ).toThrow('Invalid paper ledger');
});

test('rejects corrupt decisions, missing parents, and conflicting duplicate lifecycle records', () => {
  const decision = makeDecision();
  const fill = makeFill(decision);
  const noFill = simulatePaperFill({ decision, book: null, now: NOW + 2000 });
  expect(() =>
    getPaperPortfolio({ decisions: [{ ...decision, reservedCapital: 0 }], now: NOW }),
  ).toThrow('Invalid paper ledger');
  expect(() => getPaperPortfolio({ events: [fill], now: NOW + 2000 })).toThrow(
    'Invalid paper ledger',
  );
  expect(() =>
    getPaperPortfolio({ decisions: [decision], events: [fill, noFill], now: NOW + 2000 }),
  ).toThrow('Invalid paper ledger');
  expect(() =>
    getPaperPortfolio({
      decisions: [decision],
      events: [makeSettlement(decision, fill)],
      now: contract.expiresAt + 5000,
    }),
  ).toThrow('Invalid paper ledger');
});

test('compares realized results with frozen probabilities valued at actual simulated fill costs', () => {
  const decision = makeDecision();
  const book = makeBook(NOW + 2000);
  book.yesAsks[0].price = 0.65;
  const fill = makeFill(decision, book);
  expect(fill.expectedNetValue).toBeCloseTo(0.85 - fill.totalCost);
  expect(fill.expectedNetValue).toBeLessThan(decision.expectedNetValue);
  const settlement = makeSettlement(decision, fill);
  const report = getPaperTradingReport({
    decisions: [decision],
    events: [fill, settlement],
    now: contract.expiresAt + 5000,
  });
  expect(report.expectedNetValue).toBe(fill.expectedNetValue);
  expect(report.conservativeExpectedNetValue).toBe(fill.conservativeExpectedNetValue);
  expect(report.intentExpectedNetValue).toBe(decision.expectedNetValue);
});

test('daily loss resets at UTC midnight without deleting cumulative profit or loss', () => {
  const decision = makeDecision();
  const fill = makeFill(decision);
  const settlement = makeSettlement(decision, fill, 'no');
  expect(
    getPaperPortfolio({
      decisions: [decision],
      events: [fill, settlement],
      now: contract.expiresAt + 5000,
    }).dailyRealizedPnl,
  ).toBe(-0.5275);
  expect(
    getPaperPortfolio({ decisions: [decision], events: [fill, settlement], now: START + 86400000 }),
  ).toMatchObject({ realizedPnl: -0.5275, dailyRealizedPnl: 0 });
});

test('reports settlement-only profit, drawdown, coverage, and model/side breakdowns', () => {
  const decision = makeDecision();
  const fill = makeFill(decision);
  const settlement = makeSettlement(decision, fill, 'no');
  const report = getPaperTradingReport({
    decisions: [decision],
    events: [fill, settlement],
    now: contract.expiresAt + 5000,
  });
  expect(report).toMatchObject({
    decisionCount: 1,
    fillCount: 1,
    settledCount: 1,
    actualNetPnl: -0.5275,
    maxRealizedDrawdown: 0.5275,
    profitFactor: 0,
    winRate: 0,
    tradeCoverage: 1,
  });
  expect(report.returnOnInitialCapital).toBeCloseTo(-0.5275 / 100);
  expect(report.expectedNetValue).toBe(decision.expectedNetValue);
  expect(report.byModel[0]).toMatchObject({
    model: decision.forecast.modelVersion,
    settledCount: 1,
  });
  expect(report.bySide[0]).toMatchObject({ side: 'yes', actualNetPnl: -0.5275 });
  expect(report.recentDecisions[0]).toMatchObject({
    status: 'settled',
    filledQuantity: 1,
    realizedPnl: -0.5275,
  });
  expect(report.equityLimitation).toMatch(/not exchange executions/);
  const empty = getPaperTradingReport({ now: NOW });
  expect(empty.profitFactor).toBeNull();
  expect(empty.winRate).toBeNull();
  expect(empty.expectedNetValue).toBeNull();
});

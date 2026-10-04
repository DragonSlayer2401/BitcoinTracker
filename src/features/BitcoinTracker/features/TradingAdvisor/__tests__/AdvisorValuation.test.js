/** @jest-environment node */
import {
  ADVISOR_VALUATION_VERSION,
  getAdvisorValuation,
  getAdvisorRiskHistory,
} from '../utils/advisorValuation.utils';
import { getTradingExecutionQuote } from '../utils/tradingAdvisor.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../../../utils/kalshi/contract.utils';

const START = Date.UTC(2026, 9, 3, 12);
const NOW = START + 540000;
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
const position = () => ({
  id: 'position-1',
  contract,
  side: 'yes',
  quantity: 10,
  availableQuantity: 10,
  costBasis: 5,
  entryFees: 0.1,
  averagePrice: 0.49,
});
const portfolio = () => ({
  cash: 95,
  reservedCapital: 0,
  openRisk: 5,
  realizedPnl: 0,
  positions: [position()],
});
const input = () => ({ portfolio: portfolio(), books: [bookAt()], now: NOW });
const historyMark = (equity, observedAt = NOW) => ({
  version: ADVISOR_VALUATION_VERSION,
  observedAt,
  complete: equity !== null,
  executableEquity: equity,
});

test('values the entire holding at adverse bid proceeds after exit fees', () => {
  const value = input();
  const original = JSON.parse(JSON.stringify(value));
  const valuation = getAdvisorValuation(value);
  const quote = getTradingExecutionQuote({
    action: 'sell',
    side: 'yes',
    quantity: 10,
    contract,
    book: value.books[0],
    now: NOW,
  });
  expect(valuation).toMatchObject({
    version: 'advisor-valuation-v1',
    complete: true,
    observedAt: NOW,
    availableCash: 95,
    reservedCapital: 0,
    committedCapitalAtRisk: 5,
    worstCaseFinalCash: 95,
    unpricedPositionCount: 0,
  });
  expect(valuation.liquidationValue).toBe(quote.netProceeds);
  expect(valuation.executableEquity).toBeCloseTo(95 + quote.netProceeds);
  expect(valuation.totalMarkedPnl).toBeCloseTo(quote.netProceeds - 5);
  expect(valuation.unrealizedPnl).toBe(valuation.totalMarkedPnl);
  expect(valuation.positions[0]).toMatchObject({
    positionId: 'position-1',
    quantity: 10,
    status: 'priced',
    netProceeds: quote.netProceeds,
    exitFee: quote.fee,
    bookReceivedAt: NOW,
  });
  expect(Object.isFrozen(valuation.positions[0])).toBe(true);
  expect(value).toEqual(original);
});

test('does not subtract entry fees a second time from a fee-inclusive cost basis', () => {
  const value = input();
  const original = getAdvisorValuation(value);
  value.portfolio.positions[0].entryFees = 2;
  expect(getAdvisorValuation(value)).toEqual(original);
});

test('pending buy reservations remain equity but can be lost in the worst case', () => {
  const value = input();
  const baseline = getAdvisorValuation(value);
  Object.assign(value.portfolio, { cash: 90, reservedCapital: 5, openRisk: 10 });
  const marked = getAdvisorValuation(value);
  expect(marked.executableEquity).toBe(baseline.executableEquity);
  expect(marked.committedCapitalAtRisk).toBe(10);
  expect(marked.worstCaseFinalCash).toBe(90);
});

test('a pending sale does not remove its contracts from marked equity', () => {
  const value = input();
  const baseline = getAdvisorValuation(value);
  value.portfolio.positions[0].availableQuantity = 0;
  expect(getAdvisorValuation(value)).toEqual(baseline);
});

test('an all-cash account retains actual historical losses instead of resetting to $100', () => {
  const marked = getAdvisorValuation({
    portfolio: {
      cash: 94.4953,
      reservedCapital: 0,
      openRisk: 0,
      realizedPnl: -5.5047,
      positions: [],
    },
    books: [],
    now: NOW,
  });
  expect(marked).toMatchObject({
    complete: true,
    executableEquity: 94.4953,
    totalMarkedPnl: -5.5047,
    unrealizedPnl: 0,
    liquidationValue: 0,
    worstCaseFinalCash: 94.4953,
  });
});

test('cash reserved for a pending entry needs no invented position mark', () => {
  const marked = getAdvisorValuation({
    portfolio: { cash: 90, reservedCapital: 10, openRisk: 10, realizedPnl: 0, positions: [] },
    now: NOW,
  });
  expect(marked).toMatchObject({
    complete: true,
    executableEquity: 100,
    totalMarkedPnl: 0,
    worstCaseFinalCash: 90,
    committedCapitalAtRisk: 10,
  });
});

test.each([
  [
    'missing book',
    (value) => {
      value.books = [];
    },
  ],
  [
    'future book',
    (value) => {
      value.books = [bookAt(NOW + 1)];
    },
  ],
  [
    'stale book',
    (value) => {
      value.books = [bookAt(NOW - 15001)];
    },
  ],
  [
    'missing fees',
    (value) => {
      value.books[0].fee.available = false;
    },
  ],
  [
    'insufficient depth',
    (value) => {
      value.books[0].noAsks[0].quantity = 9.99;
    },
  ],
  [
    'wrong ticker',
    (value) => {
      value.books[0].ticker = 'KXBTC15M-WRONG';
    },
  ],
  [
    'future request',
    (value) => {
      value.books[0].requestedAt = NOW + 1;
    },
  ],
])('marks equity unknown for %s instead of zeroing the position', (_label, mutate) => {
  const value = input();
  mutate(value);
  expect(getAdvisorValuation(value)).toMatchObject({
    complete: false,
    reason: 'incomplete_liquidation_prices',
    executableEquity: null,
    liquidationValue: null,
    totalMarkedPnl: null,
    unrealizedPnl: null,
    availableCash: 95,
    worstCaseFinalCash: 95,
    unpricedPositionCount: 1,
  });
});

test('expired but unsettled positions remain unknown even when their last book is present', () => {
  const value = input();
  value.now = contract.expiresAt;
  value.books = [bookAt(value.now)];
  const marked = getAdvisorValuation(value);
  expect(marked.complete).toBe(false);
  expect(marked.positions[0].status).toBe('awaiting_settlement');
});

test('marks settled proceeds as cash without charging another exit fee', () => {
  const marked = getAdvisorValuation({
    portfolio: { cash: 105, reservedCapital: 0, openRisk: 0, realizedPnl: 5, positions: [] },
    now: contract.expiresAt + 1000,
  });
  expect(marked).toMatchObject({
    complete: true,
    executableEquity: 105,
    totalMarkedPnl: 5,
    unrealizedPnl: 0,
    positions: [],
  });
});

test('preserves known individual marks but does not report partial account equity as complete', () => {
  const value = input();
  value.portfolio.positions.push({
    ...position(),
    id: 'position-2',
    contract: { ...contract, ticker: 'KXBTC15M-OTHER' },
  });
  value.portfolio.cash = 90;
  value.portfolio.openRisk = 10;
  const marked = getAdvisorValuation(value);
  expect(marked.complete).toBe(false);
  expect(marked.executableEquity).toBeNull();
  expect(marked.positions[0].status).toBe('priced');
  expect(marked.positions[1].status).toBe('book_unavailable');
  expect(marked.unpricedPositionCount).toBe(1);
});

test('does not consume the same displayed depth separately for duplicate holdings', () => {
  const value = input();
  value.portfolio.positions.push({ ...position(), id: 'position-2' });
  value.portfolio.cash = 90;
  value.portfolio.openRisk = 10;
  const marked = getAdvisorValuation(value);
  expect(marked).toMatchObject({
    complete: false,
    unpricedPositionCount: 2,
    committedCapitalAtRisk: 10,
    worstCaseFinalCash: 90,
  });
  expect(marked.positions.every((row) => row.status === 'shared_depth_unavailable')).toBe(true);
});

test('opposite holdings receive no assumed hedge reduction in committed risk', () => {
  const value = input();
  value.portfolio.positions.push({ ...position(), id: 'position-2', side: 'no' });
  value.portfolio.cash = 90;
  value.portfolio.openRisk = 10;
  expect(getAdvisorValuation(value)).toMatchObject({
    complete: true,
    committedCapitalAtRisk: 10,
    worstCaseFinalCash: 90,
  });
});

test('uses the newest causal book without mutating the caller book list', () => {
  const value = input();
  value.books = [bookAt(NOW - 5000), bookAt(NOW), bookAt(NOW + 5000)];
  const timestamps = value.books.map((book) => book.receivedAt);
  expect(getAdvisorValuation(value).positions[0].bookReceivedAt).toBe(NOW);
  expect(value.books.map((book) => book.receivedAt)).toEqual(timestamps);
});

test('an already fourteen-second-old book cannot appear current for another thirty seconds', () => {
  const value = input();
  value.books = [bookAt(NOW - 14000)];
  expect(getAdvisorValuation(value)).toMatchObject({ complete: true, validUntil: NOW + 1000 });
});

test('a liquidation mark expires when trading closes even with a recent book', () => {
  const value = input();
  value.now = contract.expiresAt - 1000;
  value.books = [bookAt(value.now)];
  expect(getAdvisorValuation(value)).toMatchObject({
    complete: true,
    validUntil: contract.expiresAt,
  });
});

test('fee schedule expiry and freshness can shorten the current valuation window', () => {
  const value = input();
  value.books[0].fee.validUntil = NOW + 500;
  expect(getAdvisorValuation(value).validUntil).toBe(NOW + 500);
  value.books[0].fee.validUntil = NOW + 60000;
  value.books[0].fee.checkedAt = NOW - 29000;
  expect(getAdvisorValuation(value).validUntil).toBe(NOW + 1000);
});

test('cash-only observations use the thirty-second report window', () => {
  const value = input();
  value.portfolio = { cash: 100, reservedCapital: 0, openRisk: 0, realizedPnl: 0, positions: [] };
  expect(getAdvisorValuation(value)).toMatchObject({ complete: true, validUntil: NOW + 30000 });
});

test('known prices in an incomplete account still expire on their original book deadline', () => {
  const value = input();
  value.books = [bookAt(NOW - 14000)];
  value.portfolio.positions.push({
    ...position(),
    id: 'position-2',
    contract: { ...contract, ticker: 'KXBTC15M-OTHER' },
  });
  value.portfolio.cash = 90;
  value.portfolio.openRisk = 10;
  expect(getAdvisorValuation(value)).toMatchObject({ complete: false, validUntil: NOW + 1000 });
});

test.each([
  { cash: 96 },
  { reservedCapital: 1 },
  { openRisk: 4 },
  { realizedPnl: NaN },
  { cash: -1 },
])('fails closed when account capital does not reconcile: %p', (patch) => {
  const value = input();
  Object.assign(value.portfolio, patch);
  expect(getAdvisorValuation(value)).toMatchObject({
    complete: false,
    reason: 'portfolio_unavailable',
    executableEquity: null,
    worstCaseFinalCash: null,
  });
});

test('starts sampled drawdown from the known initial bankroll and keeps existing losses', () => {
  expect(getAdvisorRiskHistory(null, historyMark(94.4953))).toEqual({
    startedAt: NOW,
    lastObservedAt: NOW,
    lastCompleteAt: NOW,
    observationCount: 1,
    completeCount: 1,
    incompleteCount: 0,
    peakEquity: 100,
    maxDrawdown: 5.5047,
    drawdown: 5.5047,
  });
});

test('tracks sampled peaks, drawdown, and recovery without claiming unsampled extrema', () => {
  let history = getAdvisorRiskHistory(null, historyMark(100));
  history = getAdvisorRiskHistory(history, historyMark(110, NOW + 1));
  history = getAdvisorRiskHistory(history, historyMark(103, NOW + 2));
  expect(history).toMatchObject({ peakEquity: 110, drawdown: 7, maxDrawdown: 7 });
  history = getAdvisorRiskHistory(history, historyMark(112, NOW + 3));
  expect(history).toMatchObject({ peakEquity: 112, drawdown: 0, maxDrawdown: 7, completeCount: 4 });
});

test('unknown marks count gaps without resetting the peak or implying total loss', () => {
  const previous = getAdvisorRiskHistory(null, historyMark(105));
  const history = getAdvisorRiskHistory(previous, historyMark(null, NOW + 1));
  expect(history).toMatchObject({
    startedAt: NOW,
    lastObservedAt: NOW + 1,
    lastCompleteAt: NOW,
    observationCount: 2,
    completeCount: 1,
    incompleteCount: 1,
    peakEquity: 105,
    maxDrawdown: 0,
    drawdown: null,
  });
  expect(previous.observationCount).toBe(1);
  expect(Object.isFrozen(history)).toBe(true);
});

test('an unknown first observation has no marked drawdown or complete timestamp', () => {
  expect(getAdvisorRiskHistory(null, historyMark(null))).toMatchObject({
    lastCompleteAt: null,
    observationCount: 1,
    completeCount: 0,
    incompleteCount: 1,
    peakEquity: 100,
    maxDrawdown: 0,
    drawdown: null,
  });
});

test('accepts distinct observations at the same millisecond but rejects a backward timestamp', () => {
  const previous = getAdvisorRiskHistory(null, historyMark(100));
  expect(getAdvisorRiskHistory(previous, historyMark(99)).observationCount).toBe(2);
  expect(() => getAdvisorRiskHistory(previous, historyMark(99, NOW - 1))).toThrow(/chronological/);
});

test.each([
  { observationCount: 2 },
  { peakEquity: 90 },
  { maxDrawdown: -1 },
  { lastCompleteAt: NOW + 1 },
  { incompleteCount: -1 },
])('rejects corrupt saved risk history instead of silently resetting it: %p', (patch) => {
  const previous = { ...getAdvisorRiskHistory(null, historyMark(100)), ...patch };
  expect(() => getAdvisorRiskHistory(previous, historyMark(99, NOW + 2))).toThrow(/valid history/);
});

test.each([NaN, -1, Infinity])('rejects an invalid complete equity value: %p', (equity) => {
  expect(() => getAdvisorRiskHistory(null, historyMark(equity))).toThrow(/valid valuation/);
});

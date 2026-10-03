/** @jest-environment node */
import { createKalshiPurchaseValueService } from '../../../services/kalshi/purchaseValue/purchaseValue.service';
import {
  parseKalshiPurchaseBook,
  parseKalshiPurchaseFees,
} from '../../../services/kalshi/purchaseValue/purchaseValue.validation';
import {
  getKalshiReadResource,
  getKalshiReadCost,
} from '../../../services/kalshi/rateLimit/rateLimit.policy';

jest.mock('server-only', () => ({}), { virtual: true });
const ticker = 'KXBTC15M-26SEP151215-15';
const eventTicker = 'KXBTC15M-26SEP151215';
const now = Date.UTC(2026, 8, 15, 12);
const series = { series: { ticker: 'KXBTC15M', fee_type: 'quadratic', fee_multiplier: 1 } };
const emptyFees = { event_fee_changes: [], cursor: '' };
const book = {
  orderbook_fp: {
    yes_dollars: [
      ['0.4200', '3.00'],
      ['0.4500', '4.50'],
    ],
    no_dollars: [['0.5000', '2.00']],
  },
};

test('converts opposite bids into sorted asks with preserved depth and timestamp', () => {
  expect(parseKalshiPurchaseBook(book, ticker, now)).toEqual({
    ticker,
    receivedAt: now,
    depthLimit: 100,
    yesAsks: [{ price: 0.5, quantity: 2 }],
    noAsks: [
      { price: 0.55, quantity: 4.5 },
      { price: 0.58, quantity: 3 },
    ],
  });
});

test.each([
  { orderbook_fp: { yes_dollars: [['0.9', '1']], no_dollars: [['0.8', '1']] } },
  { orderbook_fp: { yes_dollars: [['0.5', 'NaN']], no_dollars: [] } },
  {
    orderbook_fp: {
      yes_dollars: [
        ['0.5', '2'],
        ['0.5', '1'],
      ],
      no_dollars: [],
    },
  },
  {},
])('rejects unsafe order-book data %p', (payload) => {
  expect(() => parseKalshiPurchaseBook(payload, ticker, now)).toThrow();
});

test('applies the latest active event override and expires at an upcoming change', () => {
  const change = {
    event_ticker: eventTicker,
    series_ticker: 'KXBTC15M',
    fee_type_override: 'quadratic',
    fee_multiplier_override: 2,
    scheduled_ts: new Date(now - 1000).toISOString(),
  };
  const fees = {
    cursor: '',
    event_fee_changes: [
      change,
      { ...change, fee_multiplier_override: 3, scheduled_ts: new Date(now + 5000).toISOString() },
    ],
  };
  expect(parseKalshiPurchaseFees(series, fees, eventTicker, now)).toMatchObject({
    available: true,
    multiplier: 2,
    source: 'event override',
    validUntil: now + 5000,
  });
  fees.event_fee_changes = [{ ...change, fee_type_override: null, fee_multiplier_override: null }];
  expect(parseKalshiPurchaseFees(series, fees, eventTicker, now)).toMatchObject({
    available: true,
    multiplier: 1,
    source: 'series',
  });
});

test('requires complete override history and a supported fee model', () => {
  expect(
    parseKalshiPurchaseFees(series, { ...emptyFees, cursor: 'more' }, eventTicker, now).available,
  ).toBe(false);
  expect(
    parseKalshiPurchaseFees(
      { series: { ...series.series, fee_type: 'new-schedule' } },
      emptyFees,
      eventTicker,
      now,
    ).available,
  ).toBe(false);
});

test('requests only bounded, quota-admitted reads and preserves depth when fees fail', async () => {
  const paths = [];
  const request = jest.fn(async (path) => {
    paths.push(path);
    expect(getKalshiReadCost({ defaultCost: 10, endpointCosts: [] }, path)).toBe(10);
    if (path.includes('orderbook')) return book;
    throw new Error('Fee service unavailable');
  });
  const result = await createKalshiPurchaseValueService({
    request,
    now: () => now,
  }).fetchPurchaseValue(ticker);
  expect(paths).toEqual([
    `/markets/${ticker}/orderbook?depth=100`,
    '/series/KXBTC15M',
    `/events/fee_changes?event_ticker=${eventTicker}&limit=100`,
  ]);
  expect(result.yesAsks).toEqual([{ price: 0.5, quantity: 2 }]);
  expect(result.fee.available).toBe(false);
});

test.each([
  `/markets/${ticker}/orderbook?depth=0`,
  `/markets/${ticker}/orderbook?depth=101`,
  `/markets/${ticker}/orderbook?depth=100&extra=true`,
  '/events/fee_changes',
  `/events/fee_changes?event_ticker=${eventTicker}&limit=100&cursor=anything`,
  '/events/fee_changes?event_ticker=KXETH15M-26SEP151215&limit=100',
])('rejects unbounded or unrelated purchase reads %s', (path) => {
  expect(() => getKalshiReadResource(path)).toThrow();
});

/** @jest-environment node */
import {
  createKalshiRatePolicy,
  getKalshiReadCost,
  getKalshiReadResource,
} from '../../../services/kalshi/rateLimit/rateLimit.policy';
import { KalshiDataError } from '../../../services/kalshi/kalshi.validation';

const ticker = 'KXBTC15M-26SEP101830-30';
const now = Date.parse('2026-09-10T21:50:00Z');
const limits = {
  read: { refill_rate: 200, bucket_capacity: 400 },
  write: { refill_rate: 100, bucket_capacity: 200 },
};
const costs = { default_cost: 10, endpoint_costs: [] };
const createPolicy = (overrides = {}) =>
  createKalshiRatePolicy(
    limits,
    { ...costs, ...overrides },
    { credentialFingerprint: 'test', now },
  );

describe('Kalshi read resource restrictions', () => {
  it.each([
    ['/series/KXBTC15M', false, false],
    ['/markets?series_ticker=KXBTC15M', false, false],
    [
      '/markets?series_ticker=KXBTC15M&status=open&limit=100&exchange_index=2&max_close_ts=1789077600',
      false,
      false,
    ],
    ['/markets?series_ticker=KXBTC15M&status=unopened', false, false],
    [`/markets/${ticker}`, false, false],
    [`/historical/markets/${ticker}`, false, false],
    ['/cfbenchmarks/values?id=BRTI', true, false],
    ['/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND', true, false],
    ['/account/limits', false, true],
    ['/account/endpoint_costs', false, true],
  ])('allows the existing read %s', (path, isBenchmark, isDiscovery) => {
    expect(getKalshiReadResource(path)).toEqual({
      path: path.split('?')[0],
      isBenchmark,
      isDiscovery,
    });
  });

  it.each([
    null,
    {},
    'https://external-api.kalshi.com/trade-api/v2/account/limits',
    '//external-api.kalshi.com/account/limits',
    '/portfolio/orders',
    '/account/api_usage',
    '/account/limits?',
    '/account/limits?method=POST',
    '/account/limits#fragment',
    '/account/limits\n',
    '/account\\limits',
    '/account/../account/limits',
    '/%61ccount/limits',
    '/account%2flimits',
    '/account/%252e%252e/limits',
    '/account//limits',
    '/account/limits/',
    '/series/KXETH15M',
    '/markets',
    '/markets?series_ticker=KXBTC15M&series_ticker=KXETH15M',
    '/markets?series_ticker=KXBTC15M&cursor=arbitrary',
    '/markets?series_ticker=KXBTC15M&limit=101',
    '/markets?series_ticker=KXBTC15M&limit=-1',
    '/markets?series_ticker=KXBTC15M&limit=1e2',
    '/markets?series_ticker=KXBTC15M&limit=01',
    '/markets?series_ticker=KXBTC15M&exchange_index=101',
    '/markets?series_ticker=KXBTC15M&max_close_ts=9007199254740992',
    '/markets?series_ticker=KXBTC15M&status=settled',
    '/markets?series_ticker=KXBTC15M&',
    '/markets?series_ticker=KXBTC15M?status=open',
    '/markets?series_ticker=KXBTC15M=status',
    '/markets?series_ticker=KXBTC15M&limit=',
    `/markets/${ticker}/orderbook`,
    `/markets/${ticker}\n`,
    `/markets/${ticker}\r`,
    `/markets/${ticker}?extra=true`,
    '/markets/KXETH15M-26SEP101830-30',
    '/cfbenchmarks/values',
    '/cfbenchmarks/values?id=ETHUSD_RTI',
    '/cfbenchmarks/values?id=BRTI&id=BRTI',
    '/cfbenchmarks/values?id=BRTI&maxResolution=PER_MILLISECOND',
    '/cfbenchmarks/values?id=BRTI&history=true',
    '/cfbenchmarks/values?id=%42RTI',
  ])('rejects unsupported or disguised request %p', (path) => {
    expect(() => getKalshiReadResource(path)).toThrow(KalshiDataError);
    expect(() => getKalshiReadResource(path)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('Kalshi conservative account policy', () => {
  it('reserves at most half the reported read budget and caps the app at 100 tokens', () => {
    expect(createPolicy()).toEqual({
      credentialFingerprint: 'test',
      checkedAt: now,
      expiresAt: now + 300_000,
      refillRate: 100,
      bucketCapacity: 100,
      defaultCost: 10,
      endpointCosts: [],
      reportedRead: limits.read,
      reportedWrite: limits.write,
    });
    const smallerLimits = {
      read: { refill_rate: 51, bucket_capacity: 80 },
      write: { refill_rate: 0, bucket_capacity: 0 },
    };
    expect(createKalshiRatePolicy(smallerLimits, costs, { now })).toMatchObject({
      refillRate: 25.5,
      bucketCapacity: 40,
      reportedWrite: smallerLimits.write,
    });
  });

  it.each([undefined, null, '200', NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed account budget %p',
    (value) => {
      for (const bucket of ['read', 'write']) {
        for (const field of ['refill_rate', 'bucket_capacity']) {
          expect(() =>
            createKalshiRatePolicy(
              { ...limits, [bucket]: { ...limits[bucket], [field]: value } },
              costs,
            ),
          ).toThrow(KalshiDataError);
        }
      }
    },
  );

  it('does not enable requests with an absent or exhausted read budget', () => {
    for (const read of [undefined, {}, { refill_rate: 0, bucket_capacity: 200 }]) {
      expect(() => createKalshiRatePolicy({ ...limits, read }, costs)).toThrow(KalshiDataError);
    }
  });

  it.each([
    undefined,
    {},
    { default_cost: '10', endpoint_costs: [] },
    { default_cost: -1, endpoint_costs: [] },
    { default_cost: 10 },
    { default_cost: 10, endpoint_costs: {} },
    { default_cost: 10, endpoint_costs: [null] },
    { default_cost: 10, endpoint_costs: [{ method: 'get', path: '/markets', cost: 10 }] },
    { default_cost: 10, endpoint_costs: [{ method: 'GET', path: '/markets', cost: '10' }] },
  ])('fails closed when endpoint costs cannot be verified: %p', (payload) => {
    expect(() => createKalshiRatePolicy(limits, payload)).toThrow(KalshiDataError);
  });

  it('cannot reserve below the documented cost floors', () => {
    const policy = createPolicy({
      default_cost: 0,
      endpoint_costs: [{ method: 'GET', path: '/cfbenchmarks/values', cost: 1 }],
    });
    expect(getKalshiReadCost(policy, '/cfbenchmarks/values?id=BRTI')).toBe(50);
    expect(getKalshiReadCost(policy, '/account/limits')).toBe(10);
  });

  it.each([
    '/cfbenchmarks/values',
    '/trade-api/v2/cfbenchmarks/values',
    '/cfbenchmarks/{path}',
    '/trade-api/v2/cfbenchmarks/{*path}',
    '/trade-api/v2/cfbenchmarks/*endpoint',
    '/cfbenchmarks/*',
    '/trade-api/v2/*',
  ])('recognizes the benchmark cost pattern %s without its query', (path) => {
    const policy = createPolicy({ endpoint_costs: [{ method: 'GET', path, cost: 80 }] });
    expect(getKalshiReadCost(policy, '/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND')).toBe(
      80,
    );
  });

  it('matches market placeholders and chooses the highest applicable GET cost', () => {
    const policy = createPolicy({
      endpoint_costs: [
        { method: 'GET', path: '/trade-api/v2/markets/{ticker}', cost: 30 },
        { method: 'GET', path: '/trade-api/v2/markets/:ticker', cost: 35 },
        { method: 'GET', path: '/markets/{*path}', cost: 40 },
        { method: 'GET', path: `/markets/${ticker}`, cost: 20 },
        { method: 'POST', path: '/markets/{ticker}', cost: 99 },
        { method: 'GET', path: '/series/{ticker}', cost: 60 },
        { method: 'GET', path: '/historical/markets/{ticker}', cost: 70 },
      ],
    });
    expect(getKalshiReadCost(policy, `/markets/${ticker}`)).toBe(40);
    expect(getKalshiReadCost(policy, `/historical/markets/${ticker}`)).toBe(70);
    expect(getKalshiReadCost(policy, '/markets?series_ticker=KXBTC15M')).toBe(10);
    expect(getKalshiReadCost(policy, '/series/KXBTC15M')).toBe(60);
  });

  it('accepts the live costs response including unrelated write and colon-parameter routes', () => {
    const policy = createPolicy({
      endpoint_costs: [
        { method: 'GET', path: '/trade-api/v2/cfbenchmarks', cost: 50 },
        { method: 'GET', path: '/trade-api/v2/cfbenchmarks/*endpoint', cost: 50 },
        { method: 'GET', path: '/trade-api/v2/margin/balance', cost: 5 },
        { method: 'POST', path: '/trade-api/v2/communications/quotes/:quote_id/accept', cost: 10 },
        { method: 'DELETE', path: '/trade-api/v2/portfolio/orders/:order_id', cost: 10 },
      ],
    });
    expect(getKalshiReadCost(policy, '/cfbenchmarks/values?id=BRTI')).toBe(50);
    expect(getKalshiReadCost(policy, '/account/limits')).toBe(10);
    expect(() => getKalshiReadResource('/portfolio/orders/example')).toThrow(KalshiDataError);
  });

  it('does not discount an endpoint below a raised default', () => {
    const policy = createPolicy({
      default_cost: 90,
      endpoint_costs: [{ method: 'GET', path: '/cfbenchmarks/values', cost: 60 }],
    });
    expect(getKalshiReadCost(policy, '/cfbenchmarks/values?id=BRTI')).toBe(90);
  });

  it.each([
    'https://external-api.kalshi.com/markets',
    '//markets',
    '/markets/',
    '/markets?limit=100',
    '/markets/{ticker}#suffix',
    '/markets/%7Bticker%7D',
    '/markets/../account',
    '/markets/{*path}/suffix',
    '/markets/*/suffix',
    '/markets/{ticker',
    '/markets/{path:.*}',
    '/cfbenchmarks/val*',
    '/markets/(.*)',
    '/markets\\{ticker}',
    '/markets/{ticker}\n',
  ])('rejects unsupported cost patterns instead of ignoring an unknown charge: %s', (path) => {
    expect(() => createPolicy({ endpoint_costs: [{ method: 'GET', path, cost: 80 }] })).toThrow(
      KalshiDataError,
    );
  });
});

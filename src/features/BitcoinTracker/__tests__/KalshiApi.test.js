/** @jest-environment node */
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import { parseEnv } from 'node:util';
import { GET as getMarkets } from '../../../app/api/kalshi/markets/route';
import { GET as getMarket } from '../../../app/api/kalshi/markets/[ticker]/route';
import { GET as getBenchmark } from '../../../app/api/kalshi/benchmark/route';
import { fetchKalshiMarketClient } from '../../../services/kalshi/kalshi.client.service';
import {
  createKalshiReadHeaders,
  fetchKalshiBenchmark,
  fetchKalshiMarket,
  fetchKalshiMarkets,
} from '../../../services/kalshi/kalshi.service';
import {
  parseKalshiBenchmark,
  parseKalshiMarket,
  parseKalshiSeries,
} from '../../../services/kalshi/kalshi.validation';

jest.mock('server-only', () => ({}), { virtual: true });

const now = Date.parse('2026-09-10T21:50:00Z');
const seriesPayload = {
  series: {
    ticker: 'KXBTC15M',
    exchange_index: 2,
    frequency: 'fifteen_min',
    contract_terms_url: 'https://assets.kalshi.com/contract_terms/CRYPTO.pdf',
    settlement_sources: [{ name: 'CF Benchmarks' }],
  },
};
const marketPayload = {
  ticker: 'KXBTC15M-26SEP101800-00',
  event_ticker: 'KXBTC15M-26SEP101800',
  exchange_index: 2,
  market_type: 'binary',
  strike_type: 'greater_or_equal',
  custom_strike: { round_digits: '2' },
  floor_strike: 77132.46,
  open_time: '2026-09-10T21:45:00Z',
  close_time: '2026-09-10T22:00:00Z',
  expiration_time: '2026-09-17T22:00:00Z',
  expected_expiration_time: '2026-09-10T22:05:00Z',
  status: 'active',
  result: '',
  expiration_value: '',
  yes_bid_dollars: '0.6800',
  yes_ask_dollars: '0.6900',
  no_bid_dollars: '0.3100',
  no_ask_dollars: '0.3200',
  rules_primary:
    "If the simple average of the sixty seconds of CF Benchmarks' BRTI before 6:00 PM EDT on Sep 10, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before 5:45 PM EDT on September 10, 2026, then the market resolves to Yes.",
  rules_secondary:
    "Not all cryptocurrency price data is the same. While checking a source like Google or Coinbase may help guide your decision, the price used to determine this market is based on CF Benchmarks' corresponding Real Time Index (RTI). At the last minute before expiration, 60 RTI prices are collected. The official and final value is the average of these prices, rounded to the nearest 2 decimal places.",
};
const normalizedSeries = parseKalshiSeries(seriesPayload);
const sample = (time, value = '77132.46', extra = {}) => ({ time, value, ...extra });
const samplePayload = (rows) => ({ data: { payload: rows } });
const response = (payload, options) => Response.json(payload, options);

describe('Kalshi contract and benchmark integration', () => {
  let originalFetch;
  let originalEnvironment;
  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnvironment = process.env;
    process.env = { ...process.env };
    delete process.env.KALSHI_API_KEY_ID;
    delete process.env.KALSHI_PRIVATE_KEY;
    delete process.env.RESEARCH_API_USERNAME;
    delete process.env.RESEARCH_API_PASSWORD;
    delete process.env.VERCEL;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnvironment;
    jest.restoreAllMocks();
  });

  it('uses the official strike, trading close, rounding and equality rule', () => {
    expect(parseKalshiMarket(marketPayload, normalizedSeries)).toMatchObject({
      ticker: marketPayload.ticker,
      target: 77132.46,
      startsAt: Date.parse(marketPayload.open_time),
      expiresAt: Date.parse(marketPayload.close_time),
      settlementExpectedAt: Date.parse(marketPayload.expected_expiration_time),
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
      yesBid: 0.68,
      yesAsk: 0.69,
      noBid: 0.31,
      noAsk: 0.32,
      outcomeDefinition: 'kalshi-btc15m-brti-average-v1',
      result: null,
    });
  });

  it.each([
    { strike_type: 'greater' },
    { close_time: '2026-09-10T22:05:00Z' },
    { rules_primary: marketPayload.rules_primary.replace('6:00 PM', '6:15 PM') },
    { rules_primary: marketPayload.rules_primary.replace('is at least', 'is below') },
    { rules_secondary: marketPayload.rules_secondary.replace('2 decimal', '3 decimal') },
    { custom_strike: { round_digits: '3' } },
  ])('marks changed contract rules unsupported instead of silently guessing: %j', (changes) => {
    expect(
      parseKalshiMarket({ ...marketPayload, ...changes }, normalizedSeries).rulesVerified,
    ).toBe(false);
  });

  it('preserves a not-yet-published target as missing', () => {
    expect(
      parseKalshiMarket({ ...marketPayload, floor_strike: undefined }, normalizedSeries),
    ).toMatchObject({ target: null });
  });

  it('only exposes finalized official results and their settlement timestamp', () => {
    const completed = {
      ...marketPayload,
      status: 'finalized',
      result: 'no',
      expiration_value: '77000.23',
      settlement_ts: '2026-09-10T22:00:03Z',
    };
    expect(parseKalshiMarket(completed, normalizedSeries)).toMatchObject({
      result: 'no',
      settlementPrice: 77000.23,
      settledAt: Date.parse(completed.settlement_ts),
    });
    expect(
      parseKalshiMarket({ ...completed, status: 'determined' }, normalizedSeries).result,
    ).toBeNull();
  });

  it('discovers the series shard and returns current contracts first', async () => {
    global.fetch
      .mockResolvedValueOnce(response(seriesPayload))
      .mockResolvedValueOnce(response({ markets: [marketPayload] }))
      .mockResolvedValueOnce(response({ markets: [] }));
    const result = await fetchKalshiMarkets();
    expect(result.markets).toHaveLength(1);
    expect(
      global.fetch.mock.calls
        .slice(1)
        .every(([url]) => new URL(url).searchParams.get('exchange_index') === '2'),
    ).toBe(true);
    expect(result.markets[0].rulesVerified).toBe(true);
  });

  it('falls back to the official historical market endpoint for archived contracts', async () => {
    global.fetch.mockImplementation((url) => {
      if (url.endsWith('/series/KXBTC15M')) return Promise.resolve(response(seriesPayload));
      if (url.includes('/historical/markets/'))
        return Promise.resolve(response({ market: marketPayload }));
      return Promise.resolve(response({}, { status: 404 }));
    });
    expect((await fetchKalshiMarket(marketPayload.ticker)).ticker).toBe(marketPayload.ticker);
    expect(global.fetch.mock.calls.some(([url]) => url.includes('/historical/markets/'))).toBe(
      true,
    );
  });

  it('rejects non-Bitcoin and path-injection market identifiers before making requests', async () => {
    await expect(fetchKalshiMarket('../portfolio/balance')).rejects.toMatchObject({ status: 400 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns real per-second samples in chronological order with duplicate seconds removed', () => {
    const parsed = parseKalshiBenchmark(
      samplePayload([sample(now), sample(now - 1_000, '7.712e4'), sample(now)]),
      now,
    );
    expect(parsed).toMatchObject({
      status: 'live',
      available: true,
      current: { time: now, price: 77132.46 },
    });
    expect(parsed.samples).toEqual([
      { time: now - 1_000, price: 77120 },
      { time: now, price: 77132.46 },
    ]);
  });

  it('retains the full recent hour for BRTI volatility while bounding older readings', () => {
    const rows = [
      sample(now - 3_600_000),
      sample(now - 3_599_000),
      sample(now - 30 * 60_000),
      sample(now),
    ];
    const parsed = parseKalshiBenchmark(samplePayload(rows), now);
    expect(parsed.samples.map(({ time }) => time)).toEqual([
      now - 3_599_000,
      now - 30 * 60_000,
      now,
    ]);
    expect(parsed.history).toEqual({
      windowMinutes: 60,
      sampleCount: 3,
      expectedSampleCount: 3_600,
      missingSampleCount: 3_597,
      coverage: 3 / 3_600,
      firstSampleAt: now - 3_599_000,
      lastSampleAt: now,
    });
  });

  it('reports missing history without manufacturing prices or counting duplicate seconds', () => {
    const rows = Array.from({ length: 3_600 }, (_, index) => sample(now - (3_599 - index) * 1_000));
    expect(parseKalshiBenchmark(samplePayload(rows), now).history).toMatchObject({
      sampleCount: 3_600,
      missingSampleCount: 0,
      coverage: 1,
    });
    const removedTime = rows[1_800].time;
    rows.splice(1_800, 1);
    rows.push(sample(now));
    const parsed = parseKalshiBenchmark(samplePayload(rows), now);
    expect(parsed.history).toMatchObject({ sampleCount: 3_599, missingSampleCount: 1 });
    expect(parsed.samples.some(({ time }) => time === removedTime)).toBe(false);
  });

  it.each([
    [sample(now), sample(now, '1')],
    [sample(now + 2_000)],
    [sample(now - 200)],
    [sample(now, 'NaN')],
    [sample(now, '0')],
  ])('rejects contradictory, future, subsecond, or invalid official samples: %j', (rows) => {
    expect(() => parseKalshiBenchmark(samplePayload(rows), now)).toThrow();
  });

  it('does not treat stale data, replacement values, or the public rolling-average chart as live raw BRTI', () => {
    expect(parseKalshiBenchmark(samplePayload([sample(now - 10_000)]), now).status).toBe('stale');
    expect(
      parseKalshiBenchmark(
        samplePayload([sample(now, '77100', { repeatOfPreviousValue: true })]),
        now,
      ).samples,
    ).toEqual([]);
    expect(() =>
      parseKalshiBenchmark({ live_data: { details: { timeseries: [{ t: now, v: 77100 }] } } }, now),
    ).toThrow();
  });

  it('reports missing credentials without using a fake benchmark or contacting the network', async () => {
    const result = await fetchKalshiBenchmark();
    expect(result).toMatchObject({
      status: 'not-configured',
      available: false,
      current: null,
      samples: [],
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('signs only the fixed read-only CF resource with RSA-PSS and excludes query parameters', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const environment = {
      KALSHI_API_KEY_ID: 'test-key',
      KALSHI_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    const headers = createKalshiReadHeaders('/cfbenchmarks/values?id=BRTI', environment, now);
    expect(
      verify(
        'sha256',
        Buffer.from(`${now}GET/trade-api/v2/cfbenchmarks/values`),
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'),
      ),
    ).toBe(true);
    expect(() => createKalshiReadHeaders('/portfolio/orders', environment, now)).toThrow(
      'not supported',
    );
  });

  it.each([
    ['pkcs1', 'multiline'],
    ['pkcs1', 'escaped'],
    ['pkcs8', 'multiline'],
    ['pkcs8', 'escaped'],
  ])('loads a quoted %s %s environment key and fetches fresh BRTI', async (type, format) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type, format: 'pem' });
    const value = format === 'escaped' ? pem.replace(/\n/g, '\\n') : pem;
    Object.assign(
      process.env,
      parseEnv(`KALSHI_API_KEY_ID=test-key\nKALSHI_PRIVATE_KEY="${value}"`),
    );
    global.fetch.mockResolvedValue(response(samplePayload([sample(now)])));

    expect(await fetchKalshiBenchmark()).toMatchObject({ status: 'live', available: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(
      'https://external-api.kalshi.com/trade-api/v2/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND',
    );
    expect(options.headers['KALSHI-ACCESS-KEY']).toBe('test-key');
    expect(
      verify(
        'sha256',
        Buffer.from(`${now}GET/trade-api/v2/cfbenchmarks/values`),
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        Buffer.from(options.headers['KALSHI-ACCESS-SIGNATURE'], 'base64'),
      ),
    ).toBe(true);
  });

  it('reports an invalid signing key without contacting Kalshi or exposing the key', async () => {
    process.env.KALSHI_API_KEY_ID = 'private-id';
    process.env.KALSHI_PRIVATE_KEY = 'invalid-secret-key';
    const result = await fetchKalshiBenchmark();
    expect(result).toMatchObject({
      status: 'unavailable',
      available: false,
      reason: 'The server-side Kalshi signing key is invalid.',
    });
    expect(JSON.stringify(result)).not.toMatch(/private-id|invalid-secret-key/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent BRTI reads and preserves the original receipt time in its brief cache', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.KALSHI_API_KEY_ID = 'test-key';
    process.env.KALSHI_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    global.fetch.mockImplementation(() => Promise.resolve(response(samplePayload([sample(now)]))));
    const [first, concurrent] = await Promise.all([
      fetchKalshiBenchmark(),
      fetchKalshiBenchmark({ expiresAt: now + 900_000 }),
    ]);
    expect(first).toEqual(concurrent);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    Date.now.mockReturnValue(now + 999);
    expect((await fetchKalshiBenchmark()).receivedAt).toBe(now);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    Date.now.mockReturnValue(now + 1_000);
    expect((await fetchKalshiBenchmark()).receivedAt).toBe(now + 1_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('never shares cached entitled data across credential changes or removal', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.KALSHI_API_KEY_ID = 'first-key';
    process.env.KALSHI_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    global.fetch.mockImplementation(() => Promise.resolve(response(samplePayload([sample(now)]))));
    await fetchKalshiBenchmark();

    process.env.KALSHI_API_KEY_ID = 'second-key';
    await fetchKalshiBenchmark();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][1].headers['KALSHI-ACCESS-KEY']).toBe('second-key');

    delete process.env.KALSHI_PRIVATE_KEY;
    expect(await fetchKalshiBenchmark()).toMatchObject({ status: 'not-configured', samples: [] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])('reports denied benchmark access safely for HTTP %i', async (status) => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.KALSHI_API_KEY_ID = 'private-id';
    process.env.KALSHI_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
    global.fetch.mockResolvedValue(response({ error: 'secret-upstream-details' }, { status }));
    const result = await fetchKalshiBenchmark();
    expect(result).toMatchObject({ status: 'unauthorized', available: false, current: null });
    expect(result.reason).toContain('entitlement');
    expect(JSON.stringify(result)).not.toMatch(/private-id|PRIVATE KEY|secret-upstream-details/);
  });

  it('keeps successful authentication with stale readings unavailable for prediction', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.KALSHI_API_KEY_ID = 'test-key';
    process.env.KALSHI_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    global.fetch.mockResolvedValue(response(samplePayload([sample(now - 10_000)])));
    expect(await fetchKalshiBenchmark()).toMatchObject({ status: 'stale', available: false });
  });

  it('protects entitled benchmark data with the internal app authentication policy', async () => {
    process.env.KALSHI_API_KEY_ID = 'private-id';
    process.env.KALSHI_PRIVATE_KEY = 'private-key';
    process.env.RESEARCH_API_USERNAME = 'owner';
    process.env.RESEARCH_API_PASSWORD = 'secret';
    const result = await getBenchmark(new Request('https://tracker.example/api/kalshi/benchmark'));
    expect(result.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await result.json())).not.toContain('private-key');
  });

  it('keeps the missing-credential response available and rejects invalid requested windows', async () => {
    const result = await getBenchmark(new Request('http://localhost:3000/api/kalshi/benchmark'));
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe('not-configured');
    const invalid = await getBenchmark(
      new Request('http://localhost:3000/api/kalshi/benchmark?expiresAt=../secret'),
    );
    expect(invalid.status).toBe(400);
  });

  it('sanitizes upstream failures on public market routes', async () => {
    global.fetch.mockRejectedValue(new Error('secret upstream internal failure'));
    const result = await getMarkets();
    expect(result.status).toBe(502);
    expect(JSON.stringify(await result.json())).not.toContain('secret');
    const invalid = await getMarket(new Request('http://localhost:3000'), {
      params: Promise.resolve({ ticker: 'invalid' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('rejects oversized upstream bodies', async () => {
    global.fetch.mockResolvedValue(response({}, { headers: { 'content-length': '1000001' } }));
    await expect(fetchKalshiMarkets()).rejects.toThrow('too much');
  });

  it('can schedule a future contract from its explicit rules before the target is published', () => {
    expect(
      parseKalshiMarket(
        {
          ...marketPayload,
          status: 'initialized',
          floor_strike: undefined,
          strike_type: undefined,
          custom_strike: undefined,
        },
        normalizedSeries,
      ),
    ).toMatchObject({
      target: null,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
    });
  });

  it('loads a pending result from the local API independently of the selected market', async () => {
    const market = parseKalshiMarket(marketPayload, normalizedSeries);
    global.fetch.mockResolvedValue(response(market));
    expect(await fetchKalshiMarketClient(market.ticker)).toEqual(market);
    expect(global.fetch.mock.calls[0][0]).toBe(`/api/kalshi/markets/${market.ticker}`);
    global.fetch.mockResolvedValue(response({ ...market, ticker: 'different' }));
    await expect(fetchKalshiMarketClient(market.ticker)).rejects.toThrow('different contract');
  });
});

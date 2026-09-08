/** @jest-environment node */
import { parseCandles, parseTicker } from '../../../services/coinbase/coinbase.service';
import { GET as getTicker } from '../../../app/api/market/ticker/route';
import { GET as getCandles } from '../../../app/api/market/candles/route';

const receiptTime = Date.parse('2026-09-07T23:22:00Z');
const ticker = {
  price: '79042.06',
  bid: '79042.06',
  ask: '79042.07',
  volume: '3225.29862048',
  time: '2026-09-07T23:21:14.947964985Z',
};
const candle = [1788823260, 79042.06, 79050.22, 79050.21, 79042.06, 0.04568686];

describe('Coinbase ticker normalization', () => {
  test('preserves the exchange trade time independently of receipt time', () => {
    expect(parseTicker(ticker, receiptTime)).toEqual({
      price: 79042.06,
      bid: 79042.06,
      ask: 79042.07,
      volume: 3225.29862048,
      time: Date.parse('2026-09-07T23:21:14.947Z'),
      receivedAt: receiptTime,
    });
  });

  test.each([undefined, null, '', ' ', 'NaN', 'Infinity', '0', '-1', '0x10', '1e3', true, 79042])(
    'rejects invalid decimal price %p',
    (price) => {
      expect(() => parseTicker({ ...ticker, price }, receiptTime)).toThrow();
    },
  );

  test.each(
    [
      null,
      [],
      {},
      { ...ticker, bid: '' },
      { ...ticker, ask: '0' },
      { ...ticker, volume: undefined },
      { ...ticker, volume: '-1' },
      { ...ticker, bid: '80000' },
      { ...ticker, time: null },
      { ...ticker, time: '2026-02-30T23:21:14Z' },
      { ...ticker, time: '2026-09-07T23:21:14' },
      { ...ticker, time: '2027-09-07T23:21:14Z' },
    ].map((payload) => [payload]),
  )('rejects a malformed ticker without inventing defaults', (payload) => {
    expect(() => parseTicker(payload, receiptTime)).toThrow();
  });

  test('allows an explicit zero volume', () => {
    expect(parseTicker({ ...ticker, volume: '0' }, receiptTime).volume).toBe(0);
  });
});

describe('Coinbase one-minute candle normalization', () => {
  test('sorts ascending and deduplicates identical rows without filling missing minutes', () => {
    const olderCandle = [candle[0] - 180, ...candle.slice(1)];
    const payload = [candle, olderCandle, [...candle]];

    expect(parseCandles(payload, receiptTime)).toEqual([
      {
        time: olderCandle[0] * 1000,
        low: 79042.06,
        high: 79050.22,
        open: 79050.21,
        close: 79042.06,
        volume: 0.04568686,
      },
      {
        time: candle[0] * 1000,
        low: 79042.06,
        high: 79050.22,
        open: 79050.21,
        close: 79042.06,
        volume: 0.04568686,
      },
    ]);
    expect(payload[0]).toBe(candle);
  });

  test.each(
    [
      null,
      {},
      [null],
      [[]],
      [candle.slice(0, 5)],
      [[...candle, 1]],
      [['1788823260', ...candle.slice(1)]],
      [[candle[0] * 1000, ...candle.slice(1)]],
      [[candle[0] + 1, ...candle.slice(1)]],
      [[0, ...candle.slice(1)]],
      [[Infinity, ...candle.slice(1)]],
      [[candle[0], '79042.06', ...candle.slice(2)]],
      [[candle[0], 80000, ...candle.slice(2)]],
      [[candle[0], 0, ...candle.slice(2)]],
      [[candle[0], candle[1], candle[2], 80000, candle[4], candle[5]]],
      [[candle[0], candle[1], candle[2], candle[3], 70000, candle[5]]],
      [[...candle.slice(0, 5), -1]],
      [[...candle.slice(0, 5), NaN]],
    ].map((payload) => [payload]),
  )('rejects invalid candle data %p', (payload) => {
    expect(() => parseCandles(payload, receiptTime)).toThrow();
  });

  test('rejects conflicting duplicates instead of choosing an arbitrary observation', () => {
    expect(() => parseCandles([candle, [...candle.slice(0, 5), 1]], receiptTime)).toThrow(
      'Conflicting Coinbase candles',
    );
  });

  test('preserves empty history and explicit zero volume', () => {
    expect(parseCandles([], receiptTime)).toEqual([]);
    expect(parseCandles([[...candle.slice(0, 5), 0]], receiptTime)[0].volume).toBe(0);
  });
});

describe('Market data route handlers', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
    jest.spyOn(Date, 'now').mockReturnValue(receiptTime);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('returns validated ticker data with server receipt time and prevents caching', async () => {
    global.fetch.mockResolvedValue(Response.json(ticker));
    const response = await getTicker();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(parseTicker(ticker, receiptTime));
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    );
  });

  test('requests a rolling three-hour window of completed minutes from the fixed product', async () => {
    global.fetch.mockResolvedValue(Response.json([candle]));
    const response = await getCandles();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(parseCandles([candle], receiptTime));
    const requestedUrl = new URL(global.fetch.mock.calls[0][0]);
    expect(requestedUrl.origin).toBe('https://api.exchange.coinbase.com');
    expect(requestedUrl.pathname).toBe('/products/BTC-USD/candles');
    expect(Object.fromEntries(requestedUrl.searchParams)).toEqual({
      granularity: '60',
      start: '2026-09-07T20:22:00.000Z',
      end: '2026-09-07T23:22:00.000Z',
    });
    expect(global.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: 'no-store' }));
  });

  test('keeps one history window within a minute and advances it after a new minute completes', async () => {
    global.fetch.mockImplementation(async () => Response.json([candle]));
    await getCandles();
    Date.now.mockReturnValue(receiptTime + 30_000);
    await getCandles();
    Date.now.mockReturnValue(receiptTime + 60_000);
    await getCandles();

    const requestedUrls = global.fetch.mock.calls.map(([url]) => new URL(url));
    expect(requestedUrls[0].href).toBe(requestedUrls[1].href);
    expect(requestedUrls[2].searchParams.get('start')).toBe('2026-09-07T20:23:00.000Z');
    expect(requestedUrls[2].searchParams.get('end')).toBe('2026-09-07T23:23:00.000Z');
  });

  test('excludes a partial candle even when its minute ends while the request is in flight', async () => {
    const completeCandle = [candle[0] - 60, ...candle.slice(1)];
    const requestStartedAt = Date.parse('2026-09-07T23:21:59Z');
    const responseReceivedAt = Date.parse('2026-09-07T23:22:01Z');
    Date.now.mockReturnValueOnce(requestStartedAt).mockReturnValue(responseReceivedAt);
    global.fetch.mockResolvedValue(Response.json([candle, completeCandle]));

    const response = await getCandles();
    const candles = await response.json();

    expect(response.status).toBe(200);
    expect(candles).toEqual(parseCandles([completeCandle], responseReceivedAt));

    // Later client-clock ticks cannot promote the discarded partial snapshot.
    Date.now.mockReturnValue(responseReceivedAt + 60_000);
    expect(candles.some((entry) => entry.time === candle[0] * 1_000)).toBe(false);
  });

  test.each([getTicker, getCandles])(
    'returns a safe error for a failed upstream request',
    async (get) => {
      global.fetch.mockResolvedValue(new Response('private upstream error', { status: 429 }));
      const response = await get();

      expect(response.status).toBe(502);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: 'Coinbase market data is temporarily unavailable. Please retry.',
      });
    },
  );

  test.each([getTicker, getCandles])(
    'returns a query error for malformed upstream data',
    async (get) => {
      global.fetch.mockResolvedValue(Response.json({ invalid: true }));
      const response = await get();

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: 'Coinbase returned invalid market data. Please retry.',
      });
    },
  );

  test('reports a network timeout as 504', async () => {
    global.fetch.mockRejectedValue(new DOMException('request expired', 'TimeoutError'));
    const response = await getTicker();

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: 'Coinbase took too long to respond. Please retry.',
    });
  });

  test('also reports a timeout while reading the response body as 504', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new DOMException('body expired', 'AbortError');
      },
    });

    expect((await getTicker()).status).toBe(504);
  });

  test('reports transport failures without exposing their raw message', async () => {
    global.fetch.mockRejectedValue(new Error('private transport detail'));
    const response = await getTicker();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Unable to reach Coinbase market data. Please retry.',
    });
  });
});

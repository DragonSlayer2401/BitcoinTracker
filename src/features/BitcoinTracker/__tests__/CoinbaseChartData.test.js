import { getCoinbaseChartData } from '../utils/coinbaseChart.utils';

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 3, 12);
const candle = (time = START, close = 102) => ({
  time,
  open: close - 2,
  high: close + 3,
  low: close - 4,
  close,
  volume: 0.75,
});
const ticker = (time = START + MINUTE, price = 106) => ({ time, price, receivedAt: time });

test('reuses real completed OHLCV candles, sorted once, without invented second-level coverage', () => {
  const input = [candle(START + MINUTE, 108), candle(), candle()];
  const result = getCoinbaseChartData({ candles: input, now: START + 2 * MINUTE });
  expect(result.source).toBe('coinbase');
  expect(result.readings).toEqual([
    { time: START + MINUTE, price: 102 },
    { time: START + 2 * MINUTE, price: 108 },
  ]);
  expect(result.candles[0]).toEqual({
    source: 'coinbase',
    ...candle(),
    endTime: START + MINUTE,
    intervalMinutes: 1,
    sampleCount: 1,
    expectedSampleCount: 1,
    sampleUnit: 'minute candles',
    isComplete: true,
    isPartial: false,
    isForming: false,
  });
  expect(result.candles.every((bar) => !('firstSampleAt' in bar) && !('lastSampleAt' in bar))).toBe(
    true,
  );
  expect(input[0].time).toBe(START + MINUTE);
  expect(input[1]).toEqual(candle());
});

test('live ticker only changes the current price marker; it never changes or creates an OHLC bar', () => {
  const now = START + MINUTE + 15_000;
  const result = getCoinbaseChartData({
    candles: [candle(), candle(START + MINUTE, 999)],
    ticker: ticker(now, 150),
    now,
    isQuoteFresh: true,
  });
  expect(result).toMatchObject({
    current: { time: now, price: 150 },
    isFresh: true,
    status: 'live',
    reason: null,
  });
  expect(result.readings).toEqual([{ time: START + MINUTE, price: 102 }]);
  expect(result.candles).toHaveLength(1);
  expect(result.candles[0]).toMatchObject({ high: 105, close: 102 });
  expect(getCoinbaseChartData({ ticker: ticker(now), now, isQuoteFresh: true })).toMatchObject({
    candles: [],
    readings: [],
    current: { time: now, price: 106 },
  });
});

test('drops incomplete or future minutes, preserves gaps, and excludes invalid or conflicting duplicates', () => {
  const rows = [
    null,
    candle(),
    candle(START + MINUTE, 200),
    candle(START + MINUTE, 201),
    candle(START + 3 * MINUTE),
    { ...candle(START + 4 * MINUTE), high: 90 },
    candle(START + 4 * MINUTE),
    { ...candle(START + 5 * MINUTE), volume: -1 },
    { ...candle(START + 6 * MINUTE), isPartial: true },
    { ...candle(START + 7 * MINUTE), close: NaN },
    candle(START + 8 * MINUTE),
    candle(START + 9 * MINUTE),
    candle(START + 1000),
  ];
  const result = getCoinbaseChartData({ candles: rows, now: START + 8 * MINUTE + 30_000 });
  expect(result.candles.map((bar) => bar.time)).toEqual([START, START + 3 * MINUTE]);
  expect(result.readings).toHaveLength(2);
});

test.each([undefined, null, 0, -1, NaN, Infinity, START + 0.5])(
  'invalid clock %p cannot produce historical or live observations',
  (now) => {
    expect(
      getCoinbaseChartData({ candles: [candle()], ticker: ticker(), now, isQuoteFresh: true }),
    ).toMatchObject({
      readings: [],
      candles: [],
      current: null,
      isFresh: false,
      status: 'unavailable',
    });
  },
);

test.each([
  null,
  { ...ticker(), time: START + 2 * MINUTE + 1 },
  { ...ticker(), receivedAt: START + 2 * MINUTE + 1 },
  { ...ticker(), price: '106' },
  { ...ticker(), price: 0 },
  { ...ticker(), price: Infinity },
  { ...ticker(), receivedAt: undefined },
  { ...ticker(), time: START - MINUTE },
])(
  'an invalid, future, or older ticker %p cannot replace a more recent completed close',
  (quote) => {
    expect(
      getCoinbaseChartData({
        candles: [candle()],
        ticker: quote,
        now: START + 2 * MINUTE,
        isQuoteFresh: true,
      }),
    ).toMatchObject({
      current: { time: START + MINUTE, price: 102 },
      isFresh: false,
      status: 'stale',
    });
  },
);

test('cached feed flags cannot make an old ticker or stale receipt fresh', () => {
  const now = START + 2 * MINUTE;
  for (const quote of [ticker(now - 20_001), { ...ticker(now), receivedAt: now - 20_001 }]) {
    expect(getCoinbaseChartData({ ticker: quote, now, isQuoteFresh: true })).toMatchObject({
      current: { time: quote.time, price: quote.price },
      isFresh: false,
      status: 'stale',
    });
  }
  expect(getCoinbaseChartData({ ticker: ticker(now), now, isQuoteFresh: false }).isFresh).toBe(
    false,
  );
  expect(
    getCoinbaseChartData({ ticker: ticker(now - 20_000), now, isQuoteFresh: true }).isFresh,
  ).toBe(true);
});

test('missing data has an honest unavailable state and no generated prices', () => {
  expect(getCoinbaseChartData({ now: START })).toMatchObject({
    readings: [],
    candles: [],
    current: null,
    isFresh: false,
    status: 'unavailable',
  });
  expect(getCoinbaseChartData().candles).toEqual([]);
});

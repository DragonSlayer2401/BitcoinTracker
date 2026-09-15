import {
  aggregateChartCandles,
  getChartIndicators,
  CHART_CANDLE_INTERVAL_MINUTES,
} from '../utils/chartIndicators.utils';
import { getBenchmarkChartData } from '../utils/benchmarkChart.utils';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 14, 12);
const values = ['ema9', 'ema21', 'macd', 'signal', 'histogram', 'rsi'];
const allUnknown = (point) => values.every((field) => point[field] === null);

function candlesFromCloses(closes, { start = START, intervalMinutes = 1 } = {}) {
  return closes.map((close, index) => {
    const time = start + index * intervalMinutes * MINUTE;
    const endTime = time + intervalMinutes * MINUTE;
    return {
      time,
      endTime,
      firstSampleAt: time + 1000,
      lastSampleAt: endTime,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      sampleCount: intervalMinutes * 60,
      expectedSampleCount: intervalMinutes * 60,
      isComplete: true,
      isPartial: false,
    };
  });
}

test('aggregates real observed seconds with (start,end] boundary ownership and a partial forming bucket', () => {
  const samples = Array.from({ length: 181 }, (_, index) => ({
    time: START + (index + 1) * 1000,
    price: index + 1,
  }));
  samples.unshift({ time: START, price: 999 });
  const now = START + 181_000;
  const minutes = getBenchmarkChartData({ samples }, now).candles;
  const combined = aggregateChartCandles(minutes, 3, now);
  expect(combined).toHaveLength(3);
  expect(combined[0]).toMatchObject({
    time: START - 3 * MINUTE,
    endTime: START,
    open: 999,
    close: 999,
    sampleCount: 1,
    isComplete: false,
    isForming: false,
  });
  expect(combined[1]).toEqual({
    time: START,
    endTime: START + 3 * MINUTE,
    firstSampleAt: START + 1000,
    lastSampleAt: START + 3 * MINUTE,
    open: 1,
    high: 180,
    low: 1,
    close: 180,
    sampleCount: 180,
    expectedSampleCount: 180,
    intervalMinutes: 3,
    isComplete: true,
    isPartial: false,
    isForming: false,
  });
  expect(combined[2]).toMatchObject({
    time: START + 3 * MINUTE,
    endTime: START + 6 * MINUTE,
    open: 181,
    close: 181,
    sampleCount: 1,
    expectedSampleCount: 180,
    isComplete: false,
    isPartial: true,
    isForming: true,
  });
});

test.each(CHART_CANDLE_INTERVAL_MINUTES)(
  '%i-minute candles preserve observed OHLC and sample totals',
  (intervalMinutes) => {
    const minutes = candlesFromCloses(Array.from({ length: 30 }, (_, index) => index + 100));
    const result = aggregateChartCandles(
      [...minutes].reverse(),
      intervalMinutes,
      START + 30 * MINUTE,
    );
    expect(result).toHaveLength(30 / intervalMinutes);
    const first = result[0];
    expect(first).toMatchObject({
      time: START,
      endTime: START + intervalMinutes * MINUTE,
      open: 100,
      close: 99 + intervalMinutes,
      high: 99.5 + intervalMinutes,
      low: 99.5,
      sampleCount: 60 * intervalMinutes,
      expectedSampleCount: 60 * intervalMinutes,
      isComplete: true,
      isPartial: false,
    });
    expect(result.every((candle) => !Object.hasOwn(candle, 'volume'))).toBe(true);
  },
);

test('missing minutes never become candles or falsely complete larger buckets', () => {
  const minutes = candlesFromCloses([100, 101, 102, 103, 104, 105]);
  const sparse = [minutes[0], minutes[2], minutes[5]];
  expect(aggregateChartCandles(sparse, 1, START + 6 * MINUTE).map((candle) => candle.time)).toEqual(
    sparse.map((candle) => candle.time),
  );
  const larger = aggregateChartCandles(sparse, 3, START + 6 * MINUTE);
  expect(larger).toHaveLength(2);
  expect(larger.map((candle) => candle.sampleCount)).toEqual([120, 60]);
  expect(
    larger.every(
      (candle) => candle.expectedSampleCount === 180 && candle.isPartial && !candle.isForming,
    ),
  ).toBe(true);
});

test('a missing second remains missing even after its minute and larger bucket have ended', () => {
  const minutes = candlesFromCloses([100, 101, 102]);
  Object.assign(minutes[1], { sampleCount: 59, isComplete: false, isPartial: true });
  expect(aggregateChartCandles(minutes, 3, START + 4 * MINUTE)[0]).toMatchObject({
    sampleCount: 179,
    expectedSampleCount: 180,
    isComplete: false,
    isPartial: true,
    isForming: false,
  });
});

test('identical duplicates are counted once while conflicting or invalid minute observations are excluded', () => {
  const minutes = candlesFromCloses([100, 101, 102]);
  const now = START + 3 * MINUTE;
  expect(aggregateChartCandles([...minutes, { ...minutes[1] }], 3, now)[0].sampleCount).toBe(180);
  const conflicting = { ...minutes[1], close: 101.25 };
  expect(aggregateChartCandles([...minutes, conflicting], 3, now)[0]).toMatchObject({
    sampleCount: 120,
    isPartial: true,
  });
  const invalid = { ...minutes[1], high: 99 };
  expect(aggregateChartCandles([invalid, ...minutes], 3, now)[0]).toMatchObject({
    sampleCount: 120,
    isPartial: true,
  });
});

test('historical aggregation never exposes prices whose last observation is after the requested clock', () => {
  const minutes = candlesFromCloses([100, 101, 102]);
  const result = aggregateChartCandles(minutes, 1, START + MINUTE);
  expect(result).toHaveLength(1);
  expect(result[0].close).toBe(100);
});

test('EMA, MACD and RSI warm up on their stated number of completed observations', () => {
  const closes = Array.from({ length: 40 }, (_, index) => index + 1);
  const { points, periods } = getChartIndicators(candlesFromCloses(closes));
  expect(periods).toEqual({
    ema9: 9,
    ema21: 21,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    rsi: 14,
  });
  expect(points).toHaveLength(40);
  expect(points[7].ema9).toBeNull();
  expect(points[8].ema9).toBeCloseTo(5, 12);
  expect(points[9].ema9).toBeCloseTo(6, 12);
  expect(points[19].ema21).toBeNull();
  expect(points[20].ema21).toBeCloseTo(11, 12);
  expect(points[24].macd).toBeNull();
  expect(points[25].macd).toBeCloseTo(7, 12);
  expect(points[32].signal).toBeNull();
  expect(points[32].histogram).toBeNull();
  expect(points[33].signal).toBeCloseTo(7, 12);
  expect(points[33].histogram).toBeCloseTo(0, 12);
  expect(points[13].rsi).toBeNull();
  expect(points[14].rsi).toBe(100);
  expect(points[39]).toMatchObject({ isFinal: true, ema9: 36, ema21: 30, rsi: 100 });
});

test('EMA uses an SMA seed and the standard exponential weight after an abrupt price change', () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 19, 4];
  const { points } = getChartIndicators(candlesFromCloses(closes));
  expect(points[8].ema9).toBeCloseTo(5, 12);
  expect(points[9].ema9).toBeCloseTo(7.8, 12);
  expect(points[10].ema9).toBeCloseTo(7.04, 12);
});

test('MACD subtracts EMA26 from EMA12 and its histogram subtracts the EMA9 signal', () => {
  const { points } = getChartIndicators(candlesFromCloses([...Array(34).fill(100), 126]));
  expect(points[33]).toMatchObject({ macd: 0, signal: 0, histogram: 0 });
  expect(points[34].macd).toBeCloseTo(56 / 27, 10);
  expect(points[34].signal).toBeCloseTo(56 / 135, 10);
  expect(points[34].histogram).toBeCloseTo(224 / 135, 10);
});

test('RSI uses Wilder smoothing of gains and losses instead of a moving average of RSI values', () => {
  const closes = [
    100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108, 107, 109, 108,
  ];
  const { points } = getChartIndicators(candlesFromCloses(closes));
  expect(points[14].rsi).toBeCloseTo(200 / 3, 10);
  expect(points[15].rsi).toBeCloseTo(3000 / 43, 10);
  expect(points[16].rsi).toBeCloseTo(39000 / 587, 10);
});

test.each([
  ['flat', Array(40).fill(100), 50, 0],
  ['rising', Array.from({ length: 40 }, (_, index) => 100 + index), 100, 7],
  ['falling', Array.from({ length: 40 }, (_, index) => 100 - index), 0, -7],
])('%s prices have a finite defined RSI and MACD', (_name, closes, rsi, macd) => {
  const last = getChartIndicators(candlesFromCloses(closes)).points.at(-1);
  expect(last.rsi).toBe(rsi);
  expect(last.macd).toBeCloseTo(macd, 10);
  expect(last.signal).toBeCloseTo(macd, 10);
  expect(last.histogram).toBeCloseTo(0, 10);
  expect(values.every((field) => Number.isFinite(last[field]))).toBe(true);
});

test('a missing candle resets every indicator without bridging its unknown price move', () => {
  const before = candlesFromCloses(Array(34).fill(100));
  const after = candlesFromCloses(
    Array.from({ length: 34 }, (_, index) => 200 + index),
    { start: START + 35 * MINUTE },
  );
  const { points } = getChartIndicators([...before, ...after]);
  expect(allUnknown(points[34])).toBe(true);
  expect(points[41].ema9).toBeNull();
  expect(points[42].ema9).toBeCloseTo(204, 10);
  expect(points[47].rsi).toBeNull();
  expect(points[48].rsi).toBe(100);
  expect(points[58].macd).toBeNull();
  expect(points[59].macd).toBeCloseTo(7, 10);
  expect(points[66].signal).toBeNull();
  expect(points[67].signal).toBeCloseTo(7, 10);
});

test.each([
  ['partial', { sampleCount: 59, isComplete: false, isPartial: true }],
  ['forming', { isForming: true }],
  ['invalid OHLC', { high: 90 }],
  ['invalid count', { sampleCount: 61 }],
  ['invalid close', { close: NaN }],
])(
  '%s candles are aligned but have no final indicators and restart the following warmup',
  (_name, changes) => {
    const before = candlesFromCloses(Array(34).fill(100));
    const uncertain = {
      ...candlesFromCloses([100], { start: START + 34 * MINUTE })[0],
      ...changes,
    };
    const after = candlesFromCloses(Array(9).fill(200), { start: START + 35 * MINUTE });
    const { points } = getChartIndicators([...before, uncertain, ...after]);
    expect(points[34].time).toBe(uncertain.time);
    expect(points[34].isFinal).toBe(false);
    expect(allUnknown(points[34])).toBe(true);
    expect(points[42].ema9).toBeNull();
    expect(points[43].ema9).toBe(200);
  },
);

test('untimed malformed entries and time regressions cannot carry a previous indicator state forward', () => {
  const candles = candlesFromCloses(Array(40).fill(100));
  const interrupted = [...candles.slice(0, 34), null, ...candles.slice(34)];
  expect(getChartIndicators(interrupted).points.slice(34).every(allUnknown)).toBe(true);
  expect(getChartIndicators([...candles].reverse()).points.every(allUnknown)).toBe(true);
});

test.each([3, 5, 15])(
  'indicator periods count %i-minute bars, not elapsed one-minute observations',
  (intervalMinutes) => {
    const candles = candlesFromCloses(
      Array.from({ length: 34 }, (_, index) => index + 1),
      { intervalMinutes },
    );
    const { points } = getChartIndicators(candles, { intervalMinutes });
    expect(points[8].ema9).toBeCloseTo(5, 12);
    expect(points[8].time).toBe(START + 8 * intervalMinutes * MINUTE);
    expect(points[33].signal).toBeCloseTo(7, 12);
  },
);

test('computing over loaded history preserves warmup values when only the final segment is displayed', () => {
  const candles = candlesFromCloses(Array(60).fill(100));
  const full = getChartIndicators(candles).points;
  const visible = full.slice(-5);
  expect(visible.every((point) => point.ema9 === 100 && point.signal === 0)).toBe(true);
  expect(getChartIndicators(candles.slice(-5)).points.every(allUnknown)).toBe(true);
});

test('empty or unsupported inputs stay unknown and display calculations do not mutate observations', () => {
  expect(aggregateChartCandles([], 1, START)).toEqual([]);
  expect(aggregateChartCandles(candlesFromCloses([100]), 2, START + MINUTE)).toEqual([]);
  expect(aggregateChartCandles(candlesFromCloses([100]), 1, NaN)).toEqual([]);
  expect(getChartIndicators(null).points).toEqual([]);
  expect(getChartIndicators(candlesFromCloses([100]), { intervalMinutes: 2 }).points).toEqual([]);
  const candles = candlesFromCloses(Array(40).fill(100));
  const original = JSON.stringify(candles);
  const aggregated = aggregateChartCandles(candles, 1, START + 40 * MINUTE);
  getChartIndicators(aggregated);
  expect(JSON.stringify(candles)).toBe(original);
  expect(aggregated[0]).not.toBe(candles[0]);
});

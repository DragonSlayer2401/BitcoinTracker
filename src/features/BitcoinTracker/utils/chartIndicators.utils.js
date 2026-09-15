const SECOND = 1000;
const MINUTE = 60_000;
export const CHART_CANDLE_INTERVAL_MINUTES = Object.freeze([1, 3, 5, 15]);
export const CHART_INDICATOR_PERIODS = Object.freeze({
  ema9: 9,
  ema21: 21,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsi: 14,
});
const candleFields = [
  'time',
  'endTime',
  'firstSampleAt',
  'lastSampleAt',
  'open',
  'high',
  'low',
  'close',
  'sampleCount',
  'expectedSampleCount',
  'isComplete',
  'isPartial',
];
const isTime = (value) => Number.isSafeInteger(value) && value > 0;
const isPrice = (value) => Number.isFinite(value) && value > 0 && value <= 1_000_000_000;
const isInterval = (value) => CHART_CANDLE_INTERVAL_MINUTES.includes(value);

function hasValidCandleObservations(candle, intervalMinutes) {
  const duration = intervalMinutes * MINUTE;
  return Boolean(
    candle &&
    isTime(candle.time) &&
    candle.time % duration === 0 &&
    isTime(candle.endTime) &&
    candle.endTime === candle.time + duration &&
    ['open', 'high', 'low', 'close'].every((field) => isPrice(candle[field])) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    isTime(candle.firstSampleAt) &&
    candle.firstSampleAt % SECOND === 0 &&
    isTime(candle.lastSampleAt) &&
    candle.lastSampleAt % SECOND === 0 &&
    candle.firstSampleAt > candle.time &&
    candle.lastSampleAt <= candle.endTime &&
    candle.firstSampleAt <= candle.lastSampleAt &&
    candle.expectedSampleCount === intervalMinutes * 60 &&
    Number.isSafeInteger(candle.sampleCount) &&
    candle.sampleCount > 0 &&
    candle.sampleCount <= candle.expectedSampleCount &&
    candle.sampleCount <= (candle.lastSampleAt - candle.firstSampleAt) / SECOND + 1,
  );
}

function hasCompleteCandleObservations(candle) {
  return (
    candle.isComplete === true &&
    candle.isPartial !== true &&
    candle.isForming !== true &&
    candle.sampleCount === candle.expectedSampleCount &&
    candle.firstSampleAt === candle.time + SECOND &&
    candle.lastSampleAt === candle.endTime
  );
}

/** Combine observed one-minute BRTI candles in (bucket start, bucket end], never filling gaps. */
export function aggregateChartCandles(oneMinuteCandles, intervalMinutes = 1, now) {
  if (!Array.isArray(oneMinuteCandles) || !isInterval(intervalMinutes) || !isTime(now)) return [];
  const observations = new Map();
  for (const candle of oneMinuteCandles) {
    if (!isTime(candle?.time) || candle.time % MINUTE !== 0) continue;
    const valid = hasValidCandleObservations(candle, 1) && candle.lastSampleAt <= now;
    if (!valid) {
      observations.set(candle.time, null);
      continue;
    }
    if (observations.has(candle.time)) {
      const previous = observations.get(candle.time);
      if (!previous || !candleFields.every((field) => previous[field] === candle[field]))
        observations.set(candle.time, null);
    } else observations.set(candle.time, candle);
  }
  const buckets = new Map();
  const duration = intervalMinutes * MINUTE;
  const sorted = [...observations.values()]
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);
  for (const candle of sorted) {
    const endTime = Math.ceil(candle.endTime / duration) * duration;
    const bucket = buckets.get(endTime) ?? { candles: [], sampleCount: 0 };
    bucket.candles.push(candle);
    bucket.sampleCount += candle.sampleCount;
    buckets.set(endTime, bucket);
  }
  return [...buckets.entries()].map(([endTime, bucket]) => {
    const first = bucket.candles[0];
    const last = bucket.candles.at(-1);
    const isComplete =
      endTime <= now &&
      bucket.candles.length === intervalMinutes &&
      bucket.candles.every(hasCompleteCandleObservations);
    return {
      time: endTime - duration,
      endTime,
      firstSampleAt: first.firstSampleAt,
      lastSampleAt: last.lastSampleAt,
      open: first.open,
      high: Math.max(...bucket.candles.map((candle) => candle.high)),
      low: Math.min(...bucket.candles.map((candle) => candle.low)),
      close: last.close,
      sampleCount: bucket.sampleCount,
      expectedSampleCount: intervalMinutes * 60,
      intervalMinutes,
      isComplete,
      isPartial: !isComplete,
      isForming: endTime > now,
    };
  });
}

/** SMA seed, then EMA = previous + (close - previous) * 2 / (period + 1). */
function createExponentialAverage(period) {
  let count = 0;
  let mean = 0;
  return (value) => {
    count++;
    mean += (value - mean) * (count <= period ? 1 / count : 2 / (period + 1));
    return count >= period ? mean : null;
  };
}

/** Wilder's initial 14-change averages, followed by smoothing with a 1/14 weight. */
function createRelativeStrengthIndex(period) {
  let previous = null;
  let changes = 0;
  let gain = 0;
  let loss = 0;
  return (close) => {
    if (previous === null) {
      previous = close;
      return null;
    }
    const change = close - previous;
    previous = close;
    changes++;
    const weight = changes <= period ? 1 / changes : 1 / period;
    gain += (Math.max(change, 0) - gain) * weight;
    loss += (Math.max(-change, 0) - loss) * weight;
    if (changes < period) return null;
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    if (gain === 0) return 0;
    return 100 - 100 / (1 + gain / loss);
  };
}

function createIndicatorState() {
  return {
    ema9: createExponentialAverage(CHART_INDICATOR_PERIODS.ema9),
    ema21: createExponentialAverage(CHART_INDICATOR_PERIODS.ema21),
    fast: createExponentialAverage(CHART_INDICATOR_PERIODS.macdFast),
    slow: createExponentialAverage(CHART_INDICATOR_PERIODS.macdSlow),
    signal: createExponentialAverage(CHART_INDICATOR_PERIODS.macdSignal),
    rsi: createRelativeStrengthIndex(CHART_INDICATOR_PERIODS.rsi),
  };
}

/**
 * Display-only indicators from chronological completed candles, before any visible crop/zoom.
 * A gap, partial candle, invalid observation, or time regression starts a fresh warmup.
 * EMA/MACD: https://www.tradingview.com/support/solutions/43000502589-moving-averages/
 * RSI: https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/
 */
export function getChartIndicators(candles, { intervalMinutes = 1 } = {}) {
  const points = [];
  if (!Array.isArray(candles) || !isInterval(intervalMinutes))
    return { points, periods: CHART_INDICATOR_PERIODS };
  let state = createIndicatorState();
  let previousEndTime = null;
  for (const candle of candles) {
    const isFinal =
      hasValidCandleObservations(candle, intervalMinutes) && hasCompleteCandleObservations(candle);
    if (!isFinal || (previousEndTime !== null && candle.time !== previousEndTime))
      state = createIndicatorState();
    previousEndTime = isFinal ? candle.endTime : null;
    if (!isTime(candle?.time)) continue;
    const point = {
      time: candle.time,
      isFinal,
      ema9: null,
      ema21: null,
      macd: null,
      signal: null,
      histogram: null,
      rsi: null,
    };
    if (isFinal) {
      point.ema9 = state.ema9(candle.close);
      point.ema21 = state.ema21(candle.close);
      point.rsi = state.rsi(candle.close);
      const fast = state.fast(candle.close);
      const slow = state.slow(candle.close);
      if (fast !== null && slow !== null) {
        point.macd = fast - slow;
        point.signal = state.signal(point.macd);
        if (point.signal !== null) point.histogram = point.macd - point.signal;
      }
    }
    points.push(point);
  }
  return { points, periods: CHART_INDICATOR_PERIODS };
}

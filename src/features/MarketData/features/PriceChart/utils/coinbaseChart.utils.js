const MINUTE = 60_000;
const MAXIMUM_QUOTE_AGE_MS = 20_000;
const candleFields = ['open', 'high', 'low', 'close', 'volume'];
const isTime = (value) => Number.isSafeInteger(value) && value > 0;
const isPrice = (value) => Number.isFinite(value) && value > 0 && value <= 1_000_000_000;

function isCompletedCandle(candle, now) {
  return Boolean(
    candle &&
    isTime(candle.time) &&
    candle.time % MINUTE === 0 &&
    candle.time + MINUTE <= now &&
    ['open', 'high', 'low', 'close'].every((field) => isPrice(candle[field])) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.volume >= 0 &&
    candle.isComplete !== false &&
    candle.isPartial !== true &&
    candle.isForming !== true,
  );
}

/** Reuse Coinbase's completed OHLCV bars without inventing intraminute trades or filling gaps. */
export function getCoinbaseChartData({ candles, ticker, now, isQuoteFresh } = {}) {
  const observations = new Map();
  if (isTime(now) && Array.isArray(candles)) {
    for (const candle of candles) {
      if (!isTime(candle?.time) || candle.time % MINUTE !== 0) continue;
      if (!isCompletedCandle(candle, now)) {
        observations.set(candle.time, null);
        continue;
      }
      if (observations.has(candle.time)) {
        const previous = observations.get(candle.time);
        if (!previous || candleFields.some((field) => previous[field] !== candle[field]))
          observations.set(candle.time, null);
      } else observations.set(candle.time, candle);
    }
  }
  const completedCandles = [...observations.values()]
    .filter(Boolean)
    .sort((left, right) => left.time - right.time)
    .map((candle) => ({
      source: 'coinbase',
      time: candle.time,
      endTime: candle.time + MINUTE,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      intervalMinutes: 1,
      sampleCount: 1,
      expectedSampleCount: 1,
      sampleUnit: 'minute candles',
      isComplete: true,
      isPartial: false,
      isForming: false,
    }));
  // A close belongs to a whole minute. Its x-coordinate is that minute's end, not a trade time.
  const readings = completedCandles.map((candle) => ({
    time: candle.endTime,
    price: candle.close,
  }));
  const lastClose = readings.at(-1) ?? null;
  const hasCurrentTicker = Boolean(
    isTime(now) &&
    isPrice(ticker?.price) &&
    isTime(ticker?.time) &&
    isTime(ticker?.receivedAt) &&
    ticker.time <= now &&
    ticker.receivedAt <= now &&
    (!lastClose || ticker.time >= lastClose.time),
  );
  const current = hasCurrentTicker ? { time: ticker.time, price: ticker.price } : lastClose;
  const isFresh = Boolean(
    hasCurrentTicker &&
    isQuoteFresh === true &&
    now - ticker.time <= MAXIMUM_QUOTE_AGE_MS &&
    now - ticker.receivedAt <= MAXIMUM_QUOTE_AGE_MS,
  );
  return {
    source: 'coinbase',
    readings,
    candles: completedCandles,
    current,
    isFresh,
    status: isFresh ? 'live' : current ? 'stale' : 'unavailable',
    reason: isFresh
      ? null
      : current
        ? 'Coinbase price is delayed; showing the latest available observation.'
        : 'Waiting for Coinbase price history.',
  };
}

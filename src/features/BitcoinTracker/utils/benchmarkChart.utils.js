import { getBenchmarkReadings } from './kalshi/benchmarkConditions.utils';

const SECOND = 1_000;
const MINUTE = 60_000;
const MAXIMUM_READING_AGE_MS = 5_000;

const isValidTime = (time) => Number.isSafeInteger(time) && time > 0;

function getChartReadings(benchmark, now) {
  if (!isValidTime(now)) return [];
  return getBenchmarkReadings(benchmark, now).filter(
    (reading) => reading.time > 0 && reading.time % SECOND === 0,
  );
}

/** Every candle contains observed BRTI seconds in (minute start, minute end]. */
function getBenchmarkCandles(readings, now) {
  const candles = new Map();
  for (const reading of readings) {
    const endTime = Math.ceil(reading.time / MINUTE) * MINUTE;
    const candle = candles.get(endTime);
    if (candle) {
      candle.high = Math.max(candle.high, reading.price);
      candle.low = Math.min(candle.low, reading.price);
      candle.close = reading.price;
      candle.lastSampleAt = reading.time;
      candle.sampleCount += 1;
    } else {
      candles.set(endTime, {
        time: endTime - MINUTE,
        endTime,
        firstSampleAt: reading.time,
        lastSampleAt: reading.time,
        open: reading.price,
        high: reading.price,
        low: reading.price,
        close: reading.price,
        sampleCount: 1,
        expectedSampleCount: 60,
      });
    }
  }
  return [...candles.values()].map((candle) => {
    const isComplete = candle.sampleCount === 60 && candle.endTime <= now;
    return { ...candle, isComplete, isPartial: !isComplete };
  });
}

/** The visible price and its history always come from the settlement index, including outages. */
export function getBenchmarkChartData(benchmark, now) {
  const readings = getChartReadings(benchmark, now);
  const current = readings.at(-1) ?? null;
  const isFresh = Boolean(
    benchmark?.available === true && current && now - current.time <= MAXIMUM_READING_AGE_MS,
  );
  const comparisonTime = current ? current.time - 15 * MINUTE : null;
  const previous = current ? readings.findLast((reading) => reading.time <= comparisonTime) : null;
  const change =
    previous && comparisonTime - previous.time <= MAXIMUM_READING_AGE_MS
      ? current.price / previous.price - 1
      : null;

  return {
    readings,
    candles: getBenchmarkCandles(readings, now),
    current,
    isFresh,
    status: isFresh ? 'live' : current ? 'stale' : 'unavailable',
    reason: isFresh
      ? null
      : benchmark?.reason ||
        (current
          ? 'The latest observed BRTI reading is not live.'
          : 'Waiting for official BRTI readings.'),
    priceChange: Number.isFinite(change) ? change : null,
  };
}

/** Historical chart data cannot establish freshness or alter the live model's input snapshot. */
export function mergeBenchmarkChartHistory(benchmarkData, history, now, windowMinutes) {
  const oldestTime = now - windowMinutes * MINUTE;
  const samples = new Map();
  for (const reading of getChartReadings({ samples: history?.samples }, now)) {
    if (reading.time >= oldestTime) samples.set(reading.time, reading);
  }
  // Current feed observations take precedence when historical backfill overlaps them.
  for (const reading of benchmarkData?.readings ?? []) {
    if (reading.time >= oldestTime) samples.set(reading.time, reading);
  }
  const merged = getBenchmarkChartData({ samples: [...samples.values()] }, now);
  return {
    ...merged,
    isFresh: benchmarkData?.isFresh === true,
    status: benchmarkData?.isFresh ? 'live' : merged.current ? 'stale' : 'unavailable',
    reason: benchmarkData?.reason ?? null,
    priceChange: benchmarkData?.priceChange ?? null,
  };
}

/**
 * Show the average of received settlement seconds, not an estimated or official outcome.
 * The model uses precisely deadline - 59 seconds through deadline, inclusive; missing slots
 * remain missing, even when the previous and next observed index values are identical.
 */
export function getBenchmarkSettlement(readings, deadline, now) {
  const result = {
    points: [],
    sampleCount: 0,
    expectedSampleCount: 60,
    elapsedSampleCount: 0,
    average: null,
    isComplete: false,
    isInProgress: false,
    missingSampleCount: 0,
  };
  if (!isValidTime(now) || !isValidTime(deadline) || deadline % SECOND !== 0) return result;

  const firstSampleAt = deadline - 59 * SECOND;
  const observations = new Map(
    getChartReadings({ samples: readings }, now).map((reading) => [reading.time, reading.price]),
  );
  result.isInProgress = now >= deadline - MINUTE && now < deadline;
  for (
    let sampleTime = firstSampleAt;
    sampleTime <= Math.min(deadline, now);
    sampleTime += SECOND
  ) {
    result.elapsedSampleCount += 1;
    const price = observations.get(sampleTime);
    if (price === undefined) continue;
    result.sampleCount += 1;
    result.average =
      result.average === null
        ? price
        : result.average + (price - result.average) / result.sampleCount;
    result.points.push({
      time: sampleTime,
      price: result.average,
      sampleCount: result.sampleCount,
    });
  }
  result.missingSampleCount = result.elapsedSampleCount - result.sampleCount;
  result.isComplete = result.sampleCount === result.expectedSampleCount;
  return result;
}

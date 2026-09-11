import jStat from 'jstat';
import { MARKET_CONDITION_GUARDS } from '../marketConditions.utils';

const MINUTE = 60_000;
const RANGE_VARIANCE_DIVISOR = 4 * Math.log(2);

// Operating and smoothing assumptions, not fitted predictors of market direction.
export const BENCHMARK_CONDITION_PARAMETERS = Object.freeze({
  minimumCompletedMinutes: 16,
  maximumCompletedMinutes: 120,
  maximumBenchmarkAgeMs: 5000,
  minimumMinuteVolatility: 0.00001,
  maximumMinuteVolatility: 0.05,
  maximumAbsoluteMinuteReturn: 0.2,
  ewmaHalfLifeMinutes: 10,
  currentJumpVolatilityWeight: 0.5,
  minimumJumpElapsedMinutes: 0.25,
});

const rootMeanSquare = (values) => Math.sqrt(jStat.mean(values.map((value) => value ** 2)));
const rangeVolatility = (ranges) => rootMeanSquare(ranges) / Math.sqrt(RANGE_VARIANCE_DIVISOR);
const logChange = (last, first) => Math.log(last) - Math.log(first);

/** Invalid, conflicting and future observations never become index history or settlement data. */
export function getBenchmarkReadings(benchmark, now) {
  const readings = new Map();
  const conflicts = new Set();
  const samples = Array.isArray(benchmark?.samples) ? benchmark.samples : [];
  for (const sample of [...samples, benchmark?.current]) {
    if (
      !sample ||
      !Number.isSafeInteger(sample.time) ||
      sample.time < 0 ||
      sample.time > now ||
      typeof sample.price !== 'number' ||
      !Number.isFinite(sample.price) ||
      sample.price <= 0
    )
      continue;
    const previous = readings.get(sample.time);
    if (previous && previous.price !== sample.price) conflicts.add(sample.time);
    readings.set(sample.time, { time: sample.time, price: sample.price });
  }
  return [...readings.values()]
    .filter((sample) => !conflicts.has(sample.time))
    .sort((left, right) => left.time - right.time);
}

/**
 * Price-only conditions from the actual settlement index. A completed minute contains every
 * once-second observation in (minute start, minute end]; no gap is interpolated into a candle.
 * Coinbase volume and order-book features remain separate: an index has no executed volume.
 */
export function getBenchmarkConditions({
  benchmark,
  now,
  target,
  readings: suppliedReadings,
} = {}) {
  const unavailable = (reason, isOutsideOperatingRange = false) => ({
    available: false,
    reason,
    isOutsideOperatingRange,
    features: null,
    riskFlags: [],
  });
  if (!Number.isSafeInteger(now) || now < 0) return unavailable('A valid clock is required.');
  const readings = suppliedReadings ?? getBenchmarkReadings(benchmark, now);
  const latest = readings.at(-1);
  if (!latest || now - latest.time > BENCHMARK_CONDITION_PARAMETERS.maximumBenchmarkAgeMs) {
    return unavailable('Fresh BRTI readings are required for index price dynamics.');
  }
  const byTime = new Map(readings.map((sample) => [sample.time, sample.price]));
  const completed = [];
  const latestMinuteEnd = Math.floor(latest.time / MINUTE) * MINUTE;
  for (let age = 0; age < BENCHMARK_CONDITION_PARAMETERS.maximumCompletedMinutes; age += 1) {
    const endAt = latestMinuteEnd - age * MINUTE;
    const prices = Array.from({ length: 60 }, (_, index) => byTime.get(endAt - index * 1000));
    if (prices.some((price) => price === undefined)) break;
    const open = byTime.get(endAt - MINUTE) ?? prices.at(-1);
    completed.unshift({
      endAt,
      close: prices[0],
      high: Math.max(open, ...prices),
      low: Math.min(open, ...prices),
    });
  }
  if (completed.length < BENCHMARK_CONDITION_PARAMETERS.minimumCompletedMinutes) {
    return unavailable('At least 16 complete, consecutive BRTI minutes are required.');
  }
  const lastMinute = completed.at(-1);
  const returns = completed
    .slice(1)
    .map((minute, index) => logChange(minute.close, completed[index].close));
  const ranges = completed.map((minute) => logChange(minute.high, minute.low));
  if (
    returns.some(
      (value) => Math.abs(value) > BENCHMARK_CONDITION_PARAMETERS.maximumAbsoluteMinuteReturn,
    )
  ) {
    return unavailable('BRTI movements are outside the model operating range.', true);
  }
  let weightedSquares = 0;
  let totalWeight = 0;
  returns
    .slice(-30)
    .reverse()
    .forEach((value, age) => {
      const weight = 0.5 ** (age / BENCHMARK_CONDITION_PARAMETERS.ewmaHalfLifeMinutes);
      weightedSquares += weight * value ** 2;
      totalWeight += weight;
    });
  // Second moments include a smooth selloff/rally instead of subtracting its average movement.
  const ewmaMinuteVolatility = Math.sqrt(weightedSquares / totalWeight);
  const rangeVolatility5Minutes = rangeVolatility(ranges.slice(-5));
  const rangeVolatility30Minutes = rangeVolatility(ranges.slice(-30));
  const recentReturnRootMeanSquare = rootMeanSquare(returns.slice(-30));
  const historicalMinuteVolatility = Math.max(
    rootMeanSquare(returns.slice(0, -5)),
    rangeVolatility(ranges.slice(0, -5)),
    BENCHMARK_CONDITION_PARAMETERS.minimumMinuteVolatility,
  );
  const shortMinuteVolatility = Math.max(
    rootMeanSquare(returns.slice(-5)),
    rangeVolatility5Minutes,
  );
  const currentJumpLogReturn = logChange(latest.price, lastMinute.close);
  const currentJumpElapsedMinutes = (latest.time - lastMinute.endAt) / MINUTE;
  const currentJumpVolatility =
    (Math.abs(currentJumpLogReturn) * BENCHMARK_CONDITION_PARAMETERS.currentJumpVolatilityWeight) /
    Math.sqrt(
      Math.max(currentJumpElapsedMinutes, BENCHMARK_CONDITION_PARAMETERS.minimumJumpElapsedMinutes),
    );
  const effectiveMinuteVolatility = Math.max(
    BENCHMARK_CONDITION_PARAMETERS.minimumMinuteVolatility,
    ewmaMinuteVolatility,
    recentReturnRootMeanSquare,
    rangeVolatility30Minutes,
    shortMinuteVolatility,
    currentJumpVolatility,
  );
  if (
    !Number.isFinite(effectiveMinuteVolatility) ||
    effectiveMinuteVolatility > BENCHMARK_CONDITION_PARAMETERS.maximumMinuteVolatility
  ) {
    return unavailable('BRTI volatility is outside the model operating range.', true);
  }
  const logReturn = (minutes) => logChange(lastMinute.close, completed.at(-1 - minutes).close);
  const upwardReturnFraction5Minutes = returns.slice(-5).filter((value) => value > 0).length / 5;
  const downwardReturnFraction5Minutes = returns.slice(-5).filter((value) => value < 0).length / 5;
  const logReturn5Minutes = logReturn(5);
  const medianHistoricalLogRange = jStat.median(ranges.slice(0, -1));
  const features = {
    completedCandleCount: completed.length,
    latestCompletedAt: lastMinute.endAt,
    logReturn1Minute: logReturn(1),
    logReturn3Minutes: logReturn(3),
    logReturn5Minutes,
    logReturn15Minutes: logReturn(15),
    logReturnAcceleration3Minutes:
      logReturn(3) - logChange(completed.at(-4).close, completed.at(-7).close),
    upwardReturnFraction5Minutes,
    downwardReturnFraction5Minutes,
    returnSignPersistence5Minutes: Math.max(
      upwardReturnFraction5Minutes,
      downwardReturnFraction5Minutes,
    ),
    momentumDirection5Minutes:
      logReturn5Minutes > 0 ? 'up' : logReturn5Minutes < 0 ? 'down' : 'flat',
    effectiveMinuteVolatility,
    ewmaMinuteVolatility,
    recentReturnRootMeanSquare,
    rangeVolatility5Minutes,
    rangeVolatility30Minutes,
    shortLongVolatilityRatio: shortMinuteVolatility / historicalMinuteVolatility,
    latestCandleLogRange: ranges.at(-1),
    medianHistoricalLogRange,
    latestRangeToMedianRatio:
      ranges.at(-1) /
      Math.max(
        medianHistoricalLogRange,
        BENCHMARK_CONDITION_PARAMETERS.minimumMinuteVolatility * Math.sqrt(RANGE_VARIANCE_DIVISOR),
      ),
    closePosition:
      lastMinute.high === lastMinute.low
        ? null
        : (lastMinute.close - lastMinute.low) / (lastMinute.high - lastMinute.low),
    currentJumpLogReturn,
    currentJumpElapsedMinutes,
    currentJumpVolatility,
    currentJumpStandardDeviations:
      currentJumpElapsedMinutes > 0
        ? Math.abs(currentJumpLogReturn) /
          (historicalMinuteVolatility * Math.sqrt(currentJumpElapsedMinutes))
        : 0,
    adverseMomentumStandardDeviations:
      Math.abs(logReturn5Minutes) / (effectiveMinuteVolatility * Math.sqrt(5)),
  };
  const riskFlags = [];
  const addRisk = (code, label, reason) => riskFlags.push({ code, label, reason });
  if (
    features.currentJumpStandardDeviations > MARKET_CONDITION_GUARDS.maximumJumpStandardDeviations
  ) {
    addRisk(
      'current-price-jump',
      'BRTI price jump',
      'The index has moved unusually quickly; settlement uncertainty has widened.',
    );
  }
  if (features.shortLongVolatilityRatio > MARKET_CONDITION_GUARDS.maximumShortLongVolatilityRatio) {
    addRisk(
      'volatility-expansion',
      'BRTI volatility expanding',
      'Recent index movement is larger than the preceding history.',
    );
  }
  if (features.latestRangeToMedianRatio > MARKET_CONDITION_GUARDS.maximumCandleRangeRatio) {
    addRisk(
      'extreme-candle-range',
      'Unusually wide BRTI minute',
      'The latest index minute covered an unusually wide range.',
    );
  }
  const currentSide = Number.isFinite(target) && target > 0 ? Math.sign(latest.price - target) : 0;
  const momentumSign = Math.sign(logReturn5Minutes);
  if (
    currentSide !== 0 &&
    momentumSign === -currentSide &&
    Math.sign(features.logReturn3Minutes) === momentumSign &&
    features.returnSignPersistence5Minutes >= MARKET_CONDITION_GUARDS.minimumMomentumPersistence &&
    features.adverseMomentumStandardDeviations >=
      MARKET_CONDITION_GUARDS.minimumAdverseMomentumStandardDeviations
  ) {
    addRisk(
      'adverse-momentum',
      'BRTI momentum against current side',
      'Persistent index movement is opposing its current side of the target.',
    );
  }
  return {
    available: true,
    reason: riskFlags[0]?.reason ?? null,
    canPublish: true,
    riskFlags,
    features,
    parameters: BENCHMARK_CONDITION_PARAMETERS,
  };
}

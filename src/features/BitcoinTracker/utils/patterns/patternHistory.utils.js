import { getBenchmarkChartData } from '../benchmarkChart.utils';
import {
  BENCHMARK_CONDITION_PARAMETERS,
  getBenchmarkConditions,
} from '../kalshi/benchmarkConditions.utils';
import { CHART_PATTERN_PARAMETERS } from './patternConfig';

export const MINUTE = 60_000;
export const SECOND = 1000;
export const getLogChange = (last, first) => Math.log(last) - Math.log(first);
export const getCandleLogRange = (candle) => getLogChange(candle.high, candle.low);
export const getObservedRange = (candles) => ({
  high: Math.max(...candles.map((candle) => candle.high)),
  low: Math.min(...candles.map((candle) => candle.low)),
});

/** Numerical inputs are bounded at 30 returns; the operating-range guard scans all history. */
function getNormalizationHistory(completed, readings, conditions) {
  const parameters = CHART_PATTERN_PARAMETERS;
  const available =
    conditions.available && completed.length >= parameters.normalizationMinimumCompletedMinutes;
  const returnCount = available
    ? Math.min(completed.length - 1, parameters.normalizationReturnCount)
    : 0;
  const rangeCandleCount = available
    ? Math.min(completed.length, parameters.normalizationRangeMinutes)
    : 0;
  const candleCount = available ? Math.max(returnCount + 1, rangeCandleCount) : 0;
  const rangeStart = available ? completed.at(-rangeCandleCount).time : null;
  const observedTimes = new Set(readings.map((reading) => reading.time));
  const rangeFirstPriceAt = available
    ? rangeStart + (observedTimes.has(rangeStart) ? 0 : SECOND)
    : null;
  const returnFirstPriceAt = available ? completed.at(-1 - returnCount).endTime : null;
  const firstPriceAt = available ? Math.min(rangeFirstPriceAt, returnFirstPriceAt) : null;
  const lastPriceAt = available ? completed.at(-1).endTime : null;
  const recentReturns = available
    ? completed
        .slice(-6)
        .slice(1)
        .map((candle, index) => getLogChange(candle.close, completed.slice(-6)[index].close))
    : [];
  return {
    source: 'getBenchmarkConditions.effectiveMinuteVolatility',
    unit: 'log return per square root minute',
    available,
    minimumCompletedMinutes: parameters.normalizationMinimumCompletedMinutes,
    configuredLookbackMinutes: parameters.normalizationLookbackMinutes,
    configuredReturnCount: parameters.normalizationReturnCount,
    configuredRangeMinutes: parameters.normalizationRangeMinutes,
    configuredValidationLookbackMinutes: parameters.normalizationValidationLookbackMinutes,
    ewmaHalfLifeMinutes: BENCHMARK_CONDITION_PARAMETERS.ewmaHalfLifeMinutes,
    minimumMinuteVolatility: BENCHMARK_CONDITION_PARAMETERS.minimumMinuteVolatility,
    maximumMinuteVolatility: BENCHMARK_CONDITION_PARAMETERS.maximumMinuteVolatility,
    maximumAbsoluteMinuteReturn: BENCHMARK_CONDITION_PARAMETERS.maximumAbsoluteMinuteReturn,
    availableCompletedMinutes: completed.length,
    actualCompletedMinutes: candleCount,
    actualReturnCount: returnCount,
    actualRangeMinutes: rangeCandleCount,
    actualCandleWindowStartAt: available ? completed.at(-candleCount).time : null,
    firstPriceAt,
    lastPriceAt,
    actualPriceSpanMinutes: available ? (lastPriceAt - firstPriceAt) / MINUTE : 0,
    validationCompletedMinutes: completed.length,
    validationReturnCount: Math.max(0, completed.length - 1),
    validationStartedAt: completed[0]?.time ?? null,
    validationEndedAt: completed.at(-1)?.endTime ?? null,
    reason: available ? null : conditions.reason,
    components: available
      ? {
          effectiveMinuteVolatility: conditions.features.effectiveMinuteVolatility,
          ewmaMinuteVolatility: conditions.features.ewmaMinuteVolatility,
          returnRootMeanSquare: conditions.features.recentReturnRootMeanSquare,
          rangeVolatility30Minutes: conditions.features.rangeVolatility30Minutes,
          rangeVolatility5Minutes: conditions.features.rangeVolatility5Minutes,
          shortReturnRootMeanSquare: Math.sqrt(
            recentReturns.reduce((total, value) => total + value ** 2, 0) / recentReturns.length,
          ),
          currentJumpVolatility: conditions.features.currentJumpVolatility,
        }
      : null,
  };
}

/** Receipt/amendment cutoffs apply before existing conflict and per-second coverage checks. */
export function getPatternHistory(benchmark, now) {
  const cutoffAt = Number.isSafeInteger(now) && now > 0 ? Math.floor(now / MINUTE) * MINUTE : null;
  const knownByCutoff = (sample) =>
    sample &&
    sample.time > cutoffAt - CHART_PATTERN_PARAMETERS.maximumHistoryMinutes * MINUTE &&
    ['receivedAt', 'sourceReceivedAt', 'amendTime'].every(
      (field) =>
        sample[field] === undefined ||
        (Number.isSafeInteger(sample[field]) && sample[field] >= 0 && sample[field] <= now),
    );
  const samples = (Array.isArray(benchmark?.samples) ? benchmark.samples : []).filter(
    knownByCutoff,
  );
  const source = {
    samples,
    current: knownByCutoff(benchmark?.current) ? benchmark.current : null,
  };
  const chart = getBenchmarkChartData(source, cutoffAt);
  const observedTimes = new Set(chart.readings.map((reading) => reading.time));
  const receivedAt = [...samples, source.current]
    .filter((sample) => sample && observedTimes.has(sample.time))
    .reduce(
      (latest, sample) =>
        Math.max(
          latest,
          sample.receivedAt ?? sample.time,
          sample.sourceReceivedAt ?? 0,
          sample.amendTime ?? 0,
        ),
      0,
    );
  const byEnd = new Map(chart.candles.map((candle) => [candle.endTime, candle]));
  const completed = [];
  for (let endAt = cutoffAt; endAt > 0; endAt -= MINUTE) {
    const candle = byEnd.get(endAt);
    if (!candle?.isComplete) break;
    completed.unshift(candle);
  }
  // Reuse the production index range/volatility calculation, evaluated only at the closed minute.
  const conditions = getBenchmarkConditions({
    benchmark: source,
    readings: chart.readings,
    now: cutoffAt,
    allowSparseInteriorReadings: false,
  });
  const normalization = getNormalizationHistory(completed, chart.readings, conditions);
  return {
    cutoffAt,
    availableAt: chart.readings.length ? Math.max(cutoffAt, receivedAt) : null,
    readings: chart.readings,
    completed,
    minuteVolatility: normalization.available
      ? conditions.features.effectiveMinuteVolatility
      : null,
    conditions: conditions.available ? conditions.features : null,
    normalization,
  };
}

export function getCoverage(history, lookbackMinutes) {
  const firstAt = history.cutoffAt - lookbackMinutes * MINUTE;
  const observedSeconds = history.readings.filter((reading) => reading.time > firstAt).length;
  const expectedSeconds = lookbackMinutes * 60;
  return {
    lookbackMinutes,
    observedSeconds,
    expectedSeconds,
    coverage: observedSeconds / expectedSeconds,
  };
}

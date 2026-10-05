import { getBenchmarkChartData } from '../benchmarkChart.utils';
import { getBenchmarkConditions } from '../kalshi/benchmarkConditions.utils';
import { CHART_PATTERN_PARAMETERS } from './patternConfig.v1';

export const MINUTE = 60_000;
export const SECOND = 1000;
export const getLogChange = (last, first) => Math.log(last) - Math.log(first);
export const getCandleLogRange = (candle) => getLogChange(candle.high, candle.low);
export const getObservedRange = (candles) => ({
  high: Math.max(...candles.map((candle) => candle.high)),
  low: Math.min(...candles.map((candle) => candle.low)),
});

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
  return {
    cutoffAt,
    availableAt: chart.readings.length ? Math.max(cutoffAt, receivedAt) : null,
    readings: chart.readings,
    completed,
    minuteVolatility: conditions.available ? conditions.features.effectiveMinuteVolatility : null,
    conditions: conditions.available ? conditions.features : null,
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

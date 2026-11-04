import jStat from 'jstat';
import {
  CHART_PATTERN_FAMILIES,
  CHART_PATTERN_PARAMETERS as PARAMETERS,
  CHART_PATTERN_VERSION,
  PATTERN_FEATURE_DEFINITIONS,
} from './patternConfig.v1';
import {
  getCandleLogRange,
  getCoverage,
  getLogChange,
  getObservedRange,
  getPatternHistory,
  MINUTE,
  SECOND,
} from './patternHistory.v1.utils';

const isFinite = (value) => typeof value === 'number' && Number.isFinite(value);
const isTarget = (value) => isFinite(value) && value > 0;
const targetSide = (price, target) => (Math.round(price * 100) / 100 >= target ? 1 : -1);

function getRangeBreakout(history, minutes) {
  const { completed, readings, cutoffAt, minuteVolatility } = history;
  const result = {
    [`breakout${minutes}Direction`]: null,
    [`breakout${minutes}Distance`]: null,
    [`breakout${minutes}ElapsedSeconds`]: null,
    [`failedBreakout${minutes}Direction`]: null,
  };
  // A consistent five-minute event search needs the full preceding reference window.
  if (completed.length < minutes + PARAMETERS.breakoutMemoryMinutes) return { features: result };
  let event = null;
  let previousEvent = null;
  const recent = completed.slice(-PARAMETERS.breakoutMemoryMinutes);
  for (const candle of recent) {
    const previous = completed.filter((item) => item.endTime <= candle.time).slice(-minutes);
    const reference = getObservedRange(previous);
    if (event?.returnedAt !== null && event?.returnedAt !== undefined) {
      previousEvent = event;
      event = null;
    }
    const candleReadings = readings.filter(
      (reading) => reading.time > candle.time && reading.time <= candle.endTime,
    );
    for (const reading of candleReadings) {
      if (event?.returnedAt) continue;
      if (!event) {
        const direction =
          reading.price > reference.high ? 1 : reading.price < reference.low ? -1 : 0;
        if (!direction) continue;
        event = {
          direction,
          startedAt: reading.time,
          returnedAt: null,
          referenceStartAt: previous[0].time,
          referenceEndAt: candle.time,
          referenceHigh: reference.high,
          referenceLow: reference.low,
          maximumLogExcursion: 0,
        };
      }
      const boundary = event.direction > 0 ? event.referenceHigh : event.referenceLow;
      event.maximumLogExcursion = Math.max(
        event.maximumLogExcursion,
        event.direction * getLogChange(reading.price, boundary),
      );
      if (
        event.returnedAt === null &&
        reading.time > event.startedAt &&
        reading.price >= event.referenceLow &&
        reading.price <= event.referenceHigh
      )
        event.returnedAt = reading.time;
    }
  }
  event ??= previousEvent;
  result[`breakout${minutes}Direction`] = event?.direction ?? 0;
  result[`breakout${minutes}Distance`] =
    minuteVolatility === null ? null : (event?.maximumLogExcursion ?? 0) / minuteVolatility;
  result[`breakout${minutes}ElapsedSeconds`] = event ? (cutoffAt - event.startedAt) / SECOND : 0;
  result[`failedBreakout${minutes}Direction`] = event?.returnedAt ? event.direction : 0;
  return { features: result, event };
}

function getTargetCrossings(history, targetPrice) {
  const result = {};
  const readings = history.readings.filter(
    (reading) => reading.time >= history.cutoffAt - PARAMETERS.targetLookbackMinutes * MINUTE,
  );
  if (!isTarget(targetPrice) || !readings.length) return { features: result };
  let crossingCount = 0;
  let recrossingCount = 0;
  let aboveSeconds = 0;
  let belowSeconds = 0;
  let lastCrossing = null;
  let lastRejection = null;
  let uninterruptedCrossings = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const reading = readings[index];
    if (reading.time - previous.time !== SECOND) {
      // Neither a crossing nor its duration can be inferred across an unobserved interval.
      uninterruptedCrossings = 0;
      continue;
    }
    const side = targetSide(reading.price, targetPrice);
    if (side > 0) aboveSeconds += 1;
    else belowSeconds += 1;
    if (side === targetSide(previous.price, targetPrice)) continue;
    crossingCount += 1;
    uninterruptedCrossings += 1;
    if (uninterruptedCrossings > 1) {
      recrossingCount += 1;
      lastRejection = { direction: side, confirmedAt: reading.time };
    }
    lastCrossing = { direction: side, observedAt: reading.time };
  }
  const prices = readings.map((reading) => Math.round(reading.price * 100) / 100);
  Object.assign(result, {
    targetCrossingCount: crossingCount,
    targetRecrossingCount: recrossingCount,
    targetSecondsAbove: aboveSeconds,
    targetSecondsBelow: belowSeconds,
    targetObservedSeconds: aboveSeconds + belowSeconds,
    targetAboveExcursion: Math.max(0, Math.max(...prices) - targetPrice),
    targetBelowExcursion: Math.max(0, targetPrice - Math.min(...prices)),
    targetRejectionDirection: lastRejection?.direction ?? 0,
  });
  return {
    features: result,
    lastCrossing,
    lastRejection,
    missingDurationSeconds: PARAMETERS.targetLookbackMinutes * 60 - aboveSeconds - belowSeconds,
    equalitySide: 'yes',
    outcome: 'temporary-index-crossing-not-official-settlement',
  };
}

function getPressureConfirmation(pressure, direction, now) {
  if (
    !pressure ||
    pressure.available !== true ||
    !['coinbase', 'bybit'].includes(pressure.source) ||
    !isFinite(pressure.imbalance) ||
    Math.abs(pressure.imbalance) > 1 ||
    !Number.isSafeInteger(pressure.observedAt) ||
    !Number.isSafeInteger(pressure.receivedAt) ||
    pressure.receivedAt < pressure.observedAt ||
    pressure.observedAt > now ||
    pressure.receivedAt > now ||
    now - pressure.observedAt > PARAMETERS.maximumPressureAgeMs ||
    now - pressure.receivedAt > PARAMETERS.maximumPressureAgeMs
  )
    return null;
  return direction * pressure.imbalance;
}

function getCompressionExpansion(history, pressure, now) {
  const required = PARAMETERS.compressionHistoryMinutes + PARAMETERS.compressionMinutes + 1;
  if (history.completed.length < required) return { features: {} };
  const recent = history.completed.slice(-required);
  const preceding = recent.slice(0, PARAMETERS.compressionHistoryMinutes);
  const compressed = recent.slice(PARAMETERS.compressionHistoryMinutes, -1);
  const latest = recent.at(-1);
  const historicalRange = jStat.median(preceding.map(getCandleLogRange));
  const compressedRange = jStat.median(compressed.map(getCandleLogRange));
  // Compare the same observed-candle range definition in all three windows.
  const latestRange = getCandleLogRange(latest);
  const compressionRatio = historicalRange > 0 ? compressedRange / historicalRange : null;
  const expansionRatio = compressedRange > 0 ? latestRange / compressedRange : null;
  const reference = getObservedRange(compressed);
  const direction = latest.close > reference.high ? 1 : latest.close < reference.low ? -1 : 0;
  const breakoutDirection =
    compressionRatio !== null &&
    expansionRatio !== null &&
    compressionRatio <= PARAMETERS.maximumCompressionRatio &&
    expansionRatio >= PARAMETERS.minimumExpansionRatio
      ? direction
      : 0;
  const pressureConfirmation = getPressureConfirmation(pressure, breakoutDirection, now);
  return {
    features: {
      compressionRatio,
      expansionRatio,
      compressionBreakoutDirection: breakoutDirection,
      compressionPressureConfirmation: pressureConfirmation,
    },
    priceAvailableAt: history.availableAt,
    pressureSource: pressureConfirmation === null ? null : pressure.source,
    pressureObservedAt: pressureConfirmation === null ? null : pressure.observedAt,
    pressureReceivedAt: pressureConfirmation === null ? null : pressure.receivedAt,
    referenceHigh: reference.high,
    referenceLow: reference.low,
  };
}

function getTrendPullback(history) {
  const { completed, minuteVolatility } = history;
  const required = PARAMETERS.trendMinutes + PARAMETERS.maximumPullbackMinutes + 2;
  if (completed.length < required || minuteVolatility === null) return { features: {} };
  const features = {
    pullbackTrendDirection: 0,
    pullbackTrendStrength: 0,
    pullbackDepth: 0,
    pullbackDurationMinutes: 0,
    pullbackResumption: 0,
  };
  const lastIndex = completed.length - 1;
  // Test only pivots whose opposing move has already been observed at this cutoff.
  for (const hasResumption of [true, false]) {
    const troughIndex = hasResumption ? lastIndex - 1 : lastIndex;
    for (let duration = 1; duration <= PARAMETERS.maximumPullbackMinutes; duration += 1) {
      const pivotIndex = troughIndex - duration;
      const trendStart = completed[pivotIndex - PARAMETERS.trendMinutes];
      const pivot = completed[pivotIndex];
      const trough = completed[troughIndex];
      const trend = getLogChange(pivot.close, trendStart.close);
      const direction = Math.sign(trend);
      const strength = Math.abs(trend) / (minuteVolatility * Math.sqrt(PARAMETERS.trendMinutes));
      if (!direction || strength < PARAMETERS.minimumTrendStandardDeviations) continue;
      if (direction * (pivot.close - completed[pivotIndex - 1].close) <= 0) continue;
      const opposing = completed
        .slice(pivotIndex + 1, troughIndex + 1)
        .every(
          (candle, offset) => direction * (candle.close - completed[pivotIndex + offset].close) < 0,
        );
      if (!opposing) continue;
      const recovery = direction * getLogChange(completed[lastIndex].close, trough.close);
      if (hasResumption && recovery <= 0) continue;
      const depth = Math.abs(getLogChange(trough.close, pivot.close));
      Object.assign(features, {
        pullbackTrendDirection: direction,
        pullbackTrendStrength: strength,
        pullbackDepth: depth / Math.abs(trend),
        pullbackDurationMinutes: duration,
        pullbackResumption: hasResumption ? recovery / depth : 0,
      });
      return {
        features,
        trendStartedAt: trendStart.endTime,
        pivotAt: pivot.endTime,
        pivotConfirmedAt: completed[pivotIndex + 1].endTime,
        resumptionConfirmedAt: hasResumption ? completed[lastIndex].endTime : null,
      };
    }
  }
  return { features };
}

function getCandleShape(history) {
  const latest = history.completed.at(-1);
  if (!latest) return { features: {} };
  const range = latest.high - latest.low;
  const body = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const lowerWick = Math.min(latest.open, latest.close) - latest.low;
  const direction = Math.sign(latest.close - latest.open);
  const previous = history.completed.at(-2);
  let engulfing = previous ? 0 : null;
  if (previous && direction !== 0 && Math.sign(previous.close - previous.open) === -direction) {
    const lower = Math.min(latest.open, latest.close);
    const upper = Math.max(latest.open, latest.close);
    const previousLower = Math.min(previous.open, previous.close);
    const previousUpper = Math.max(previous.open, previous.close);
    if (
      lower <= previousLower &&
      upper >= previousUpper &&
      (lower < previousLower || upper > previousUpper)
    )
      engulfing = direction;
  }
  return {
    features: {
      candleBodyFraction: range > 0 ? body / range : 0,
      candleUpperWickFraction: range > 0 ? upperWick / range : 0,
      candleLowerWickFraction: range > 0 ? lowerWick / range : 0,
      candleBodyDirection: direction,
      candleRejection: range > 0 ? (lowerWick - upperWick) / range : 0,
      candleEngulfingDirection: engulfing,
    },
    // Retain the descriptive close location without duplicating the existing model input.
    closePosition: range > 0 ? (latest.close - latest.low) / range : null,
    bodyUsd: body,
    rangeUsd: range,
    isZeroRange: range === 0,
    candleStartedAt: latest.time,
    candleEndedAt: latest.endTime,
  };
}

/** Capture causal, price-only index patterns; missing optional evidence never changes a forecast. */
export function calculateChartPatterns({ benchmark, targetPrice, now, pressure } = {}) {
  const history = getPatternHistory(benchmark, now);
  const five = getRangeBreakout(history, 5);
  const fifteen = getRangeBreakout(history, 15);
  const outputs = {
    rangeBreakouts: {
      features: { ...five.features, ...fifteen.features },
      fiveMinuteEvent: five.event ?? null,
      fifteenMinuteEvent: fifteen.event ?? null,
    },
    targetCrossings: getTargetCrossings(history, targetPrice),
    compressionExpansion: getCompressionExpansion(history, pressure, now),
    trendPullback: getTrendPullback(history),
    candles: getCandleShape(history),
  };
  const features = Object.fromEntries(
    PATTERN_FEATURE_DEFINITIONS.map(({ name, family }) => [
      name,
      isFinite(outputs[family].features[name]) ? outputs[family].features[name] : null,
    ]),
  );
  const pressureAvailableAt =
    features.compressionPressureConfirmation === null
      ? 0
      : Math.max(pressure.observedAt, pressure.receivedAt);
  const compressionAvailableAt =
    history.availableAt === null ? null : Math.max(history.availableAt, pressureAvailableAt);
  const families = Object.fromEntries(
    CHART_PATTERN_FAMILIES.map((name) => {
      const definitions = PATTERN_FEATURE_DEFINITIONS.filter((item) => item.family === name);
      const required = definitions.filter(
        (item) => item.name !== 'compressionPressureConfirmation',
      );
      const available = required.some((item) => features[item.name] !== null);
      const coverage = getCoverage(
        history,
        Math.max(...definitions.map((item) => item.lookbackMinutes)),
      );
      const complete =
        coverage.coverage === 1 && required.every((item) => features[item.name] !== null);
      const { features: familyFeatures, ...details } = outputs[name];
      return [
        name,
        {
          available,
          complete,
          reason: complete
            ? null
            : 'Some required BRTI history, target or normalization is unavailable.',
          availableAt: available
            ? name === 'compressionExpansion'
              ? compressionAvailableAt
              : history.availableAt
            : null,
          ...coverage,
          ...details,
        },
      ];
    }),
  );
  const familyAvailableTimes = Object.values(families)
    .filter((family) => family.available)
    .map((family) => family.availableAt);
  const availableAt = familyAvailableTimes.length ? Math.max(...familyAvailableTimes) : null;
  return {
    version: CHART_PATTERN_VERSION,
    source: 'brti',
    capturedAt: Number.isSafeInteger(now) && now > 0 ? now : null,
    availableAt,
    targetPrice: isTarget(targetPrice) ? targetPrice : null,
    features,
    families,
    coverage: {
      ...getCoverage(history, 20),
      completedCandleCount: history.completed.length,
      latestCompletedAt: history.completed.at(-1)?.endTime ?? null,
      normalizedFeaturesAvailable: history.minuteVolatility !== null,
      sampleUnit: 'observed BRTI seconds',
      requiredSecondsPerCandle: PARAMETERS.requiredSecondsPerCandle,
    },
  };
}

/** Structural validation only; captured evidence is never recomputed from later history. */
export function isChartPatternSnapshot(value, { cutoffAt, target } = {}) {
  if (
    !value ||
    value.version !== CHART_PATTERN_VERSION ||
    value.source !== 'brti' ||
    !Number.isSafeInteger(value.capturedAt) ||
    value.capturedAt <= 0 ||
    (cutoffAt !== undefined && value.capturedAt !== cutoffAt) ||
    (target !== undefined && value.targetPrice !== target) ||
    (value.targetPrice !== null && !isTarget(value.targetPrice)) ||
    (value.availableAt !== null &&
      (!Number.isSafeInteger(value.availableAt) || value.availableAt > value.capturedAt)) ||
    !value.features ||
    Object.keys(value.features).length !== PATTERN_FEATURE_DEFINITIONS.length ||
    !PATTERN_FEATURE_DEFINITIONS.every(
      ({ name }) => value.features[name] === null || isFinite(value.features[name]),
    )
  )
    return false;
  return CHART_PATTERN_FAMILIES.every((name) => {
    const family = value.families?.[name];
    return (
      typeof family?.available === 'boolean' &&
      typeof family.complete === 'boolean' &&
      isFinite(family.coverage) &&
      family.coverage >= 0 &&
      family.coverage <= 1 &&
      (family.availableAt === null ||
        (Number.isSafeInteger(family.availableAt) && family.availableAt <= value.capturedAt))
    );
  });
}

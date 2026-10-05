// Frozen engineering assumptions for a prospective experiment, never fitted thresholds.
export const CHART_PATTERN_VERSION = 'brti-patterns-v1';
export const CHART_PATTERN_PARAMETERS = Object.freeze({
  version: CHART_PATTERN_VERSION,
  candleMinutes: 1,
  requiredSecondsPerCandle: 60,
  maximumHistoryMinutes: 120,
  breakoutLookbacksMinutes: Object.freeze([5, 15]),
  breakoutMemoryMinutes: 5,
  targetLookbackMinutes: 5,
  compressionHistoryMinutes: 10,
  compressionMinutes: 3,
  maximumCompressionRatio: 0.65,
  minimumExpansionRatio: 1.5,
  trendMinutes: 5,
  maximumPullbackMinutes: 3,
  minimumTrendStandardDeviations: 0.5,
  maximumPressureAgeMs: 5000,
});

const definition = (name, family, unit, lookbackMinutes, normalizationLookbackMinutes = null) =>
  Object.freeze({ name, family, unit, lookbackMinutes, normalizationLookbackMinutes });

/** Ordered detector outputs; null means unavailable, while zero means observed absence. */
export const PATTERN_FEATURE_DEFINITIONS = Object.freeze([
  ...[5, 15].flatMap((minutes) => [
    definition(`breakout${minutes}Direction`, 'rangeBreakouts', 'signed direction', minutes + 5),
    definition(
      `breakout${minutes}Distance`,
      'rangeBreakouts',
      'minute standard deviations',
      minutes + 5,
      16,
    ),
    definition(`breakout${minutes}ElapsedSeconds`, 'rangeBreakouts', 'seconds', minutes + 5),
    definition(
      `failedBreakout${minutes}Direction`,
      'rangeBreakouts',
      'signed direction',
      minutes + 5,
    ),
  ]),
  definition('targetCrossingCount', 'targetCrossings', 'observed crossings', 5),
  definition('targetRecrossingCount', 'targetCrossings', 'observed recrossings', 5),
  definition('targetSecondsAbove', 'targetCrossings', 'observed seconds', 5),
  definition('targetSecondsBelow', 'targetCrossings', 'observed seconds', 5),
  definition('targetObservedSeconds', 'targetCrossings', 'observed seconds', 5),
  definition('targetAboveExcursion', 'targetCrossings', 'USD', 5),
  definition('targetBelowExcursion', 'targetCrossings', 'USD', 5),
  definition('targetRejectionDirection', 'targetCrossings', 'signed direction', 5),
  definition('compressionRatio', 'compressionExpansion', 'range ratio', 14),
  definition('expansionRatio', 'compressionExpansion', 'range ratio', 14),
  definition('compressionBreakoutDirection', 'compressionExpansion', 'signed direction', 14),
  definition(
    'compressionPressureConfirmation',
    'compressionExpansion',
    'signed pressure agreement',
    14,
  ),
  definition('pullbackTrendDirection', 'trendPullback', 'signed direction', 10, 16),
  definition('pullbackTrendStrength', 'trendPullback', 'trend standard deviations', 10, 16),
  definition('pullbackDepth', 'trendPullback', 'fraction of preceding trend', 10, 16),
  definition('pullbackDurationMinutes', 'trendPullback', 'minutes', 10, 16),
  definition('pullbackResumption', 'trendPullback', 'fraction of pullback recovered', 10, 16),
  definition('candleBodyFraction', 'candles', 'fraction of candle range', 1),
  definition('candleUpperWickFraction', 'candles', 'fraction of candle range', 1),
  definition('candleLowerWickFraction', 'candles', 'fraction of candle range', 1),
  definition('candleBodyDirection', 'candles', 'signed direction', 1),
  definition('candleRejection', 'candles', 'signed wick fraction', 1),
  definition('candleEngulfingDirection', 'candles', 'signed direction', 2),
]);

export const CHART_PATTERN_FEATURE_DEFINITIONS = Object.freeze(
  Object.fromEntries(PATTERN_FEATURE_DEFINITIONS.map((item) => [item.name, item])),
);

export const CHART_PATTERN_FAMILIES = Object.freeze([
  'rangeBreakouts',
  'targetCrossings',
  'compressionExpansion',
  'trendPullback',
  'candles',
]);

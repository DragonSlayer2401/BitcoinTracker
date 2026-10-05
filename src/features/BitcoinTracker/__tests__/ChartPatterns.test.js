import {
  calculateChartPatterns,
  isChartPatternSnapshot,
} from '../utils/patterns/chartPatterns.utils';
import {
  CHART_PATTERN_PARAMETERS,
  CHART_PATTERN_VERSION,
  LEGACY_CHART_PATTERN_VERSION,
  PATTERN_FEATURE_DEFINITIONS,
} from '../utils/patterns/patternConfig';
import { PATTERN_FEATURE_DEFINITIONS as LEGACY_FEATURE_DEFINITIONS } from '../utils/patterns/patternConfig.v1';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 4, 12);

function candle(
  open = 100_000,
  close = open,
  low = Math.min(open, close) - 1,
  high = Math.max(open, close) + 1,
) {
  return { open, close, low, high };
}

function history(candles = Array.from({ length: 30 }, () => candle())) {
  const samples = candles.flatMap((item, index) =>
    Array.from({ length: 60 }, (_, second) => ({
      time: NOW - (candles.length - index) * MINUTE + (second + 1) * 1000,
      price:
        second === 0 ? item.open : second === 1 ? item.low : second === 2 ? item.high : item.close,
    })),
  );
  return { available: true, samples, current: samples.at(-1), receivedAt: NOW };
}

function withEnding(endings) {
  return history([...Array.from({ length: 30 - endings.length }, () => candle()), ...endings]);
}

function withMinutePaths(paths) {
  const benchmark = history();
  benchmark.samples = benchmark.samples.map((sample) => {
    const index = Math.floor((sample.time - 1000 - (NOW - paths.length * MINUTE)) / MINUTE);
    if (index < 0) return sample;
    const second = ((sample.time - 1000) % MINUTE) / 1000;
    const prices = paths[index];
    return { ...sample, price: prices[Math.min(second, prices.length - 1)] };
  });
  benchmark.current = benchmark.samples.at(-1);
  return benchmark;
}

const calculate = (benchmark = history(), extra = {}) =>
  calculateChartPatterns({ benchmark, now: NOW, targetPrice: 100_000, ...extra });

describe('causal BRTI range breakouts', () => {
  test.each([1, -1])(
    'recognizes a %i breakout against the preceding 5- and 15-minute ranges',
    (direction) => {
      const benchmark = withEnding([
        candle(
          100_000,
          100_000 + direction * 20,
          100_000 + Math.min(0, direction * 20),
          100_000 + Math.max(0, direction * 20),
        ),
      ]);
      // Make every observation beyond the reference stay outside after the first crossing.
      benchmark.samples = benchmark.samples.map((sample) =>
        sample.time > NOW - 58_000 ? { ...sample, price: 100_000 + direction * 20 } : sample,
      );
      benchmark.current = benchmark.samples.at(-1);
      const result = calculate(benchmark);
      for (const minutes of [5, 15]) {
        expect(result.features[`breakout${minutes}Direction`]).toBe(direction);
        expect(result.features[`breakout${minutes}Distance`]).toBeGreaterThan(0);
        expect(result.features[`failedBreakout${minutes}Direction`]).toBe(0);
        const event =
          result.families.rangeBreakouts[minutes === 5 ? 'fiveMinuteEvent' : 'fifteenMinuteEvent'];
        expect(event.referenceHigh).toBe(100_001);
        expect(event.referenceLow).toBe(99_999);
        expect(event.referenceEndAt).toBeLessThan(event.startedAt);
      }
    },
  );

  test('recognizes failure only after the observed return and preserves it in the memory window', () => {
    const benchmark = withEnding([
      candle(100_000, 100_020, 100_000, 100_020),
      candle(100_020, 100_000, 100_000, 100_020),
      candle(),
    ]);
    const before = calculate(benchmark, { now: NOW - 2 * MINUTE });
    const after = calculate(benchmark);
    expect(before.features.failedBreakout5Direction).toBe(0);
    expect(after.features.failedBreakout5Direction).toBe(1);
    expect(after.families.rangeBreakouts.fiveMinuteEvent.returnedAt).toBe(NOW - 118_000);
    expect(after.features.breakout5ElapsedSeconds).toBeGreaterThan(120);
  });

  test('has an observed zero rather than a false breakout for an unchanged range', () => {
    const result = calculate();
    expect(result.features.breakout5Direction).toBe(0);
    expect(result.features.breakout15Direction).toBe(0);
    expect(result.features.failedBreakout5Direction).toBe(0);
  });
});

describe('target crossing and rejection coverage', () => {
  test('cent equality belongs to YES and repeated recrossings are recorded before settlement', () => {
    const benchmark = history(
      Array.from({ length: 30 }, () => candle(99_999, 99_999, 99_999, 99_999)),
    );
    const updates = new Map([
      [NOW - 3000, 99_999.999],
      [NOW - 2000, 99_999.99],
      [NOW - 1000, 100_000],
      [NOW, 100_001],
    ]);
    benchmark.samples = benchmark.samples.map((sample) => ({
      ...sample,
      price: updates.get(sample.time) ?? sample.price,
    }));
    benchmark.current = benchmark.samples.at(-1);
    const result = calculate(benchmark);
    expect(result.features).toMatchObject({
      targetCrossingCount: 3,
      targetRecrossingCount: 2,
      targetRejectionDirection: 1,
      targetObservedSeconds: 300,
      targetSecondsAbove: 3,
      targetSecondsBelow: 297,
      targetAboveExcursion: 1,
      targetBelowExcursion: 1,
    });
    expect(result.families.targetCrossings.outcome).toContain('not-official-settlement');
  });

  test('an observation gap is neither a crossing nor uninterrupted time on a side', () => {
    const benchmark = history();
    benchmark.samples = benchmark.samples
      .filter((sample) => sample.time !== NOW - 2000)
      .map((sample) => ({
        ...sample,
        price: sample.time < NOW - 2000 ? 99_999 : 100_001,
      }));
    benchmark.current = benchmark.samples.at(-1);
    const result = calculate(benchmark);
    expect(result.features.targetCrossingCount).toBe(0);
    expect(result.features.targetRecrossingCount).toBe(0);
    expect(result.features.targetObservedSeconds).toBe(298);
    expect(result.families.targetCrossings.missingDurationSeconds).toBe(2);
    expect(result.families.targetCrossings.coverage).toBeCloseTo(299 / 300);
    expect(result.families.candles.available).toBe(false);
  });

  test('no crossing occurs when observed rounded prices stay on the YES side', () => {
    const benchmark = history(
      Array.from({ length: 30 }, () => candle(100_000, 100_000, 100_000, 100_000)),
    );
    const result = calculate(benchmark);
    expect(result.features.targetCrossingCount).toBe(0);
    expect(result.features.targetRejectionDirection).toBe(0);
    expect(result.features.targetSecondsAbove).toBe(300);
    expect(
      calculate(benchmark, { targetPrice: undefined }).features.targetCrossingCount,
    ).toBeNull();
  });
});

describe('version 2 intraminute breakout attempts', () => {
  test.each([
    ['downward then upward', [99_998, 100_000, 100_010], 1, -1, 2, 1],
    ['upward then downward', [100_010, 100_000, 99_998], -1, 1, 2, 1],
    ['repeated upward attempts', [100_010, 100_000, 100_010], 1, 1, 2, 1],
    ['repeated downward attempts', [99_998, 100_000, 99_998], -1, -1, 2, 1],
    ['multiple returns', [100_010, 100_000, 99_998, 100_000, 100_010, 100_000], 1, 1, 3, 3],
    ['no breakout', [100_000, 100_001, 99_999, 100_000], 0, 0, 0, 0],
  ])(
    '%s selects the latest attempt and latest failed attempt separately',
    (_name, prices, latestDirection, failedDirection, events, failures) => {
      const result = calculate(withMinutePaths([prices]));
      for (const [minutes, prefix] of [
        [5, 'fiveMinute'],
        [15, 'fifteenMinute'],
      ]) {
        const family = result.families.rangeBreakouts;
        expect(result.features[`breakout${minutes}Direction`]).toBe(latestDirection);
        expect(result.features[`failedBreakout${minutes}Direction`]).toBe(failedDirection);
        expect(family[`${prefix}EventCount`]).toBe(events);
        expect(family[`${prefix}FailedEventCount`]).toBe(failures);
        const latest = family[`${prefix}Event`];
        const failed = family[`${prefix}LatestFailedEvent`];
        if (!events) {
          expect(latest).toBeNull();
          expect(failed).toBeNull();
          continue;
        }
        expect(latest).toMatchObject({
          direction: latestDirection,
          referenceLow: 99_999,
          referenceHigh: 100_001,
        });
        expect(failed).toMatchObject({
          direction: failedDirection,
          referenceLow: 99_999,
          referenceHigh: 100_001,
        });
        expect(failed.returnedAt).toBeGreaterThan(failed.startedAt);
        expect(latest.referenceEndAt).toBeLessThan(latest.startedAt);
        if (failures < events) {
          expect(latest.startedAt).toBeGreaterThan(failed.returnedAt);
          expect(latest.returnedAt).toBeNull();
          expect(family[`${prefix}ActiveEvent`]).toEqual(latest);
        } else expect(family[`${prefix}ActiveEvent`]).toBeNull();
      }
    },
  );

  test('an active event keeps its original range across a candle boundary before the next attempt starts', () => {
    const result = calculate(withMinutePaths([[99_998], [100_000, 100_010]]));
    for (const prefix of ['fiveMinute', 'fifteenMinute']) {
      const family = result.families.rangeBreakouts;
      expect(family[`${prefix}LatestFailedEvent`]).toMatchObject({
        direction: -1,
        startedAt: NOW - 119_000,
        returnedAt: NOW - 59_000,
        referenceEndAt: NOW - 2 * MINUTE,
        referenceLow: 99_999,
        referenceHigh: 100_001,
      });
      expect(family[`${prefix}Event`]).toMatchObject({
        direction: 1,
        startedAt: NOW - 58_000,
        returnedAt: null,
        referenceEndAt: NOW - MINUTE,
        referenceLow: 99_998,
        referenceHigh: 100_001,
      });
    }
  });
});

describe('version 2 observed target durations', () => {
  test.each([
    ['boundary anchor missing', null, false, 300, 299, 1, false],
    ['all intervals observed', [], true, 300, 300, 0, true],
    ['interior gap', [NOW - 2000], true, 299, 298, 2, false],
    ['isolated observation', 'isolated', false, 1, 0, 300, false],
  ])(
    '%s reports sample and duration coverage independently',
    (_name, missing, anchor, samples, duration, missingDuration, complete) => {
      const benchmark = history(
        Array.from({ length: 5 }, () => candle(100_000, 100_000, 100_000, 100_000)),
      );
      if (anchor) benchmark.samples.unshift({ time: NOW - 5 * MINUTE, price: 100_000 });
      if (missing === 'isolated') benchmark.samples = [benchmark.samples.at(-1)];
      else if (missing)
        benchmark.samples = benchmark.samples.filter((sample) => !missing.includes(sample.time));
      benchmark.current = benchmark.samples.at(-1);
      const result = calculate(benchmark);
      expect(result.features.targetObservedSeconds).toBe(duration);
      expect(result.features.targetSecondsAbove).toBe(duration);
      expect(result.features.targetSecondsBelow).toBe(0);
      expect(result.features.targetCrossingCount).toBe(0);
      expect(result.families.targetCrossings).toMatchObject({
        observedSeconds: samples,
        sampleCoverage: samples / 300,
        observedDurationSeconds: duration,
        durationCoverage: duration / 300,
        missingDurationSeconds: missingDuration,
        hasBoundaryAnchor: anchor,
        complete,
        equalitySide: 'yes',
      });
    },
  );
});

describe('version 2 normalization provenance', () => {
  test('older relevant volatility changes normalization although the latest 16 minutes are identical', () => {
    const recent = [
      ...Array.from({ length: 15 }, () => candle()),
      candle(100_000, 100_010, 100_000, 100_010),
    ];
    const calm = history([...Array.from({ length: 44 }, () => candle()), ...recent]);
    const active = history([
      ...Array.from({ length: 44 }, (_item, index) =>
        candle(100_000, index === 39 ? 101_000 : 100_000),
      ),
      ...recent,
    ]);
    expect(calm.samples.slice(-16 * 60)).toEqual(active.samples.slice(-16 * 60));
    const first = calculate(calm);
    const second = calculate(active);
    expect(second.features.breakout5Direction).toBe(first.features.breakout5Direction);
    expect(second.normalization.components.effectiveMinuteVolatility).toBeGreaterThan(
      first.normalization.components.effectiveMinuteVolatility,
    );
    expect(second.features.breakout5Distance).toBeLessThan(first.features.breakout5Distance);
    expect(second.normalization).toMatchObject({
      available: true,
      minimumCompletedMinutes: 16,
      configuredLookbackMinutes: 31,
      configuredReturnCount: 30,
      configuredRangeMinutes: 30,
      configuredValidationLookbackMinutes: 120,
      actualCompletedMinutes: 31,
      actualReturnCount: 30,
      actualRangeMinutes: 30,
      actualCandleWindowStartAt: NOW - 31 * MINUTE,
      firstPriceAt: NOW - 30 * MINUTE,
      lastPriceAt: NOW,
      actualPriceSpanMinutes: 30,
      validationCompletedMinutes: 60,
      validationReturnCount: 59,
      validationStartedAt: NOW - 60 * MINUTE,
    });
    expect(
      PATTERN_FEATURE_DEFINITIONS.find(({ name }) => name === 'breakout5Distance'),
    ).toMatchObject({
      normalizationMinimumHistoryMinutes: 16,
      normalizationLookbackMinutes: 31,
      normalizationValidationLookbackMinutes: 120,
    });
  });

  test('minimum, configured and actual history remain distinct for short inputs and operating-range rejection', () => {
    const minimum = calculate(history(Array.from({ length: 16 }, () => candle())));
    expect(minimum.normalization).toMatchObject({
      available: true,
      minimumCompletedMinutes: 16,
      configuredLookbackMinutes: 31,
      actualCompletedMinutes: 16,
      actualReturnCount: 15,
      actualRangeMinutes: 16,
      firstPriceAt: NOW - 16 * MINUTE + 1000,
    });
    const guarded = history(Array.from({ length: 60 }, () => candle()));
    guarded.samples = guarded.samples.map((sample) =>
      sample.time === NOW - 40 * MINUTE ? { ...sample, price: 150_000 } : sample,
    );
    const result = calculate(guarded);
    expect(result.normalization).toMatchObject({
      available: false,
      configuredLookbackMinutes: 31,
      validationCompletedMinutes: 60,
      actualCompletedMinutes: 0,
    });
    expect(result.normalization.reason).toContain('operating range');
    expect(result.features.breakout5Distance).toBeNull();
  });
});

test('explicit v1 replay preserves its frozen outputs, feature order and historical metadata', () => {
  const benchmark = withMinutePaths([[99_998, 100_000, 100_010]]);
  const before = JSON.stringify(benchmark);
  const legacy = calculate(benchmark, { version: LEGACY_CHART_PATTERN_VERSION });
  const current = calculate(benchmark);
  expect(current.version).toBe(CHART_PATTERN_VERSION);
  expect(current.version).toBe('brti-patterns-v2');
  expect(legacy.version).toBe('brti-patterns-v1');
  for (const minutes of [5, 15]) {
    expect(legacy.features[`breakout${minutes}Direction`]).toBe(-1);
    expect(legacy.features[`failedBreakout${minutes}Direction`]).toBe(-1);
    expect(current.features[`breakout${minutes}Direction`]).toBe(1);
    expect(current.features[`failedBreakout${minutes}Direction`]).toBe(-1);
  }
  expect(legacy.normalization).toBeUndefined();
  expect(
    LEGACY_FEATURE_DEFINITIONS.find(({ name }) => name === 'breakout5Distance')
      .normalizationLookbackMinutes,
  ).toBe(16);
  expect(Object.keys(current.features)).toEqual(Object.keys(legacy.features));
  expect(isChartPatternSnapshot(legacy, { cutoffAt: NOW, target: 100_000 })).toBe(true);
  expect(JSON.stringify(benchmark)).toBe(before);
  const withoutAnchor = history(Array.from({ length: 5 }, () => candle()));
  expect(
    calculate(withoutAnchor, { version: LEGACY_CHART_PATTERN_VERSION }).families.targetCrossings
      .complete,
  ).toBe(true);
  expect(calculate(withoutAnchor).families.targetCrossings.complete).toBe(false);
  expect(calculate(benchmark, { version: LEGACY_CHART_PATTERN_VERSION })).toEqual(legacy);
});

describe('compression followed by expansion', () => {
  function compressedHistory(direction = 1, hasCompression = true) {
    return withEnding([
      ...Array.from({ length: 10 }, () => candle(100_000, 100_000, 99_990, 100_010)),
      ...Array.from({ length: 3 }, () =>
        candle(
          100_000,
          100_000,
          hasCompression ? 99_999 : 99_990,
          hasCompression ? 100_001 : 100_010,
        ),
      ),
      direction === 1
        ? candle(100_000, 100_015, 100_000, 100_020)
        : candle(100_000, 99_985, 99_980, 100_000),
    ]);
  }

  test.each([1, -1])(
    'measures compression, expansion and %i direction independently',
    (direction) => {
      const result = calculate(compressedHistory(direction), {
        pressure: {
          available: true,
          source: 'coinbase',
          observedAt: NOW,
          receivedAt: NOW,
          imbalance: direction * 0.4,
        },
      });
      expect(result.features.compressionRatio).toBeLessThan(0.2);
      expect(result.features.expansionRatio).toBeGreaterThan(5);
      expect(result.features.compressionBreakoutDirection).toBe(direction);
      expect(result.features.compressionPressureConfirmation).toBe(0.4);
      expect(result.families.compressionExpansion.pressureSource).toBe('coinbase');
    },
  );

  test('expansion alone and unavailable exchange pressure do not imply confirmation', () => {
    const result = calculate(compressedHistory(1, false));
    expect(result.features.compressionBreakoutDirection).toBe(0);
    expect(result.features.compressionPressureConfirmation).toBeNull();
    const inventedIndexPressure = calculate(compressedHistory(), {
      pressure: { available: true, source: 'brti', observedAt: NOW, receivedAt: NOW, imbalance: 1 },
    });
    expect(inventedIndexPressure.features.compressionPressureConfirmation).toBeNull();
  });

  test('pressure confirmation becomes available on receipt while completed-price availability stays unchanged', () => {
    const benchmark = compressedHistory();
    const pressure = {
      available: true,
      source: 'bybit',
      observedAt: NOW + 2000,
      receivedAt: NOW + 3000,
      imbalance: 0.6,
    };
    const result = calculate(benchmark, { now: NOW + 4000, pressure });
    expect(result.availableAt).toBe(NOW + 3000);
    expect(result.features.compressionPressureConfirmation).toBe(0.6);
    expect(result.families.compressionExpansion).toMatchObject({
      availableAt: NOW + 3000,
      priceAvailableAt: NOW,
      pressureObservedAt: NOW + 2000,
      pressureReceivedAt: NOW + 3000,
      pressureSource: 'bybit',
    });
    expect(result.families.candles.availableAt).toBe(NOW);
    expect(isChartPatternSnapshot(result, { cutoffAt: NOW + 4000, target: 100_000 })).toBe(true);

    // Even an already observed exchange event was not usable before this worker received it.
    const beforeReceipt = { now: NOW + 2500 };
    expect(calculate(benchmark, { ...beforeReceipt, pressure })).toEqual(
      calculate(benchmark, beforeReceipt),
    );
    const stale = calculate(benchmark, { now: NOW + 8000, pressure });
    expect(stale.features.compressionPressureConfirmation).toBeNull();
    expect(stale.families.compressionExpansion.pressureReceivedAt).toBeNull();
    expect(stale.availableAt).toBe(NOW);
  });
});

describe('trend pullbacks with causal confirmation', () => {
  function trendHistory(direction, resumes = true) {
    const movements = [0, 20, 40, 60, 80, 100, 120, 100, 80, resumes ? 110 : 60];
    return withEnding(movements.map((movement) => candle(100_000 + direction * movement)));
  }

  test.each([1, -1])(
    'detects a %i trend, two-minute pullback and subsequent resumption',
    (direction) => {
      const result = calculate(trendHistory(direction));
      expect(result.features.pullbackTrendDirection).toBe(direction);
      expect(result.features.pullbackTrendStrength).toBeGreaterThan(0.5);
      expect(result.features.pullbackDurationMinutes).toBe(2);
      expect(result.features.pullbackDepth).toBeGreaterThan(0);
      expect(result.features.pullbackResumption).toBeGreaterThan(0);
      expect(result.families.trendPullback.pivotConfirmedAt).toBeGreaterThan(
        result.families.trendPullback.pivotAt,
      );
      expect(result.families.trendPullback.resumptionConfirmedAt).toBe(NOW);
      const before = calculate(trendHistory(direction), { now: NOW - MINUTE });
      expect(before.features.pullbackResumption).toBe(0);
    },
  );

  test('does not claim resumption during a continuing opposing move or a flat trend', () => {
    expect(calculate(trendHistory(1, false)).features.pullbackResumption).toBe(0);
    expect(calculate().features.pullbackTrendDirection).toBe(0);
    expect(calculate().features.pullbackResumption).toBe(0);
  });
});

describe('completed candle rejection and body engulfing', () => {
  test.each([
    [1, candle(100_010, 100_000, 99_999, 100_011), candle(99_999, 100_011, 99_980, 100_012)],
    [-1, candle(100_000, 100_010, 99_999, 100_011), candle(100_011, 99_999, 99_998, 100_030)],
  ])('measures %i engulfing and signed wick rejection', (direction, previous, latest) => {
    const result = calculate(withEnding([previous, latest]));
    expect(result.features.candleEngulfingDirection).toBe(direction);
    expect(result.features.candleBodyDirection).toBe(direction);
    expect(Math.sign(result.features.candleRejection)).toBe(direction);
    expect(
      result.features.candleBodyFraction +
        result.features.candleUpperWickFraction +
        result.features.candleLowerWickFraction,
    ).toBeCloseTo(1);
    expect(result.families.candles.closePosition).toBeGreaterThan(0);
  });

  test('same-direction and equal-size bodies are not engulfing', () => {
    expect(
      calculate(withEnding([candle(100_000, 100_010), candle(99_999, 100_011)])).features
        .candleEngulfingDirection,
    ).toBe(0);
    expect(
      calculate(withEnding([candle(100_010, 100_000), candle(100_000, 100_010)])).features
        .candleEngulfingDirection,
    ).toBe(0);
  });

  test('flat zero-range candles have explicit finite shape values and undefined close location', () => {
    const result = calculate(
      history(Array.from({ length: 30 }, () => candle(100_000, 100_000, 100_000, 100_000))),
    );
    expect(result.features).toMatchObject({
      candleBodyFraction: 0,
      candleUpperWickFraction: 0,
      candleLowerWickFraction: 0,
      candleBodyDirection: 0,
      candleRejection: 0,
      candleEngulfingDirection: 0,
      compressionRatio: null,
      expansionRatio: null,
    });
    expect(result.families.candles).toMatchObject({ isZeroRange: true, closePosition: null });
  });
});

describe('coverage, snapshot provenance and look-ahead prevention', () => {
  test('adding future candles, delayed samples and future amendments cannot alter an earlier cutoff', () => {
    const benchmark = history();
    const now = NOW - 2 * MINUTE + 15_000;
    const earlier = {
      ...benchmark,
      current: null,
      samples: benchmark.samples.filter((sample) => sample.time <= now),
    };
    const expected = calculate(earlier, { now });
    const future = {
      ...benchmark,
      samples: [
        ...benchmark.samples,
        { time: NOW - 5 * MINUTE, price: 999_999, receivedAt: NOW },
        { time: NOW - 6 * MINUTE, price: 999_999, amendTime: NOW },
      ],
    };
    expect(calculate(future, { now })).toEqual(expected);
  });

  test('a forming candle does not affect completed-candle outputs', () => {
    const benchmark = history();
    const now = NOW + 30_000;
    const partial = {
      ...benchmark,
      samples: [...benchmark.samples, { time: now, price: 200_000 }],
      current: { time: now, price: 200_000 },
    };
    expect(calculate(partial, { now })).toEqual(calculate(benchmark, { now }));
  });

  test('missing completed seconds and insufficient history stay unavailable without fabricating volume', () => {
    const short = calculate(history([candle()]));
    expect(short.families.candles.available).toBe(true);
    expect(short.features.candleEngulfingDirection).toBeNull();
    expect(short.families.rangeBreakouts.available).toBe(false);
    expect(short.families.trendPullback.available).toBe(false);
    const absent = calculate(undefined, { benchmark: undefined });
    expect(Object.values(absent.features).every((value) => value === null)).toBe(true);
    expect(JSON.stringify(absent)).not.toContain('volume');
    expect(absent.coverage.observedSeconds).toBe(0);
  });

  test('capture does not mutate the observations and records versioned units and cutoffs', () => {
    const benchmark = history();
    const before = JSON.stringify(benchmark);
    const result = calculate(benchmark);
    expect(JSON.stringify(benchmark)).toBe(before);
    expect(isChartPatternSnapshot(result, { cutoffAt: NOW, target: 100_000 })).toBe(true);
    expect(isChartPatternSnapshot(result, { cutoffAt: NOW + 1 })).toBe(false);
    expect(isChartPatternSnapshot(result, { target: 100_001 })).toBe(false);
    expect(Object.isFrozen(CHART_PATTERN_PARAMETERS)).toBe(true);
    expect(PATTERN_FEATURE_DEFINITIONS.every((item) => item.unit && item.lookbackMinutes > 0)).toBe(
      true,
    );
    expect(PATTERN_FEATURE_DEFINITIONS.map((item) => item.name)).toEqual(
      Object.keys(result.features),
    );
  });

  test('late receipt makes the feature available at receipt, not at the historical candle close', () => {
    const benchmark = history();
    benchmark.samples = benchmark.samples.map((sample) => ({ ...sample, receivedAt: NOW + 2000 }));
    benchmark.current = benchmark.samples.at(-1);
    const result = calculate(benchmark, { now: NOW + 3000 });
    expect(result.availableAt).toBe(NOW + 2000);
    expect(calculate(benchmark).families.candles.available).toBe(false);
  });
});

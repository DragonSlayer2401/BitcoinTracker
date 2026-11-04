import {
  BENCHMARK_CONDITION_PARAMETERS,
  getBenchmarkConditions,
} from '../utils/kalshi/benchmarkConditions.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 17, 12);

function history({
  now = NOW,
  missing = [],
  priceAt = (seconds) => 100_000 * Math.exp(seconds * 0.000002),
} = {}) {
  const samples = Array.from({ length: 3601 }, (_, index) => {
    const seconds = index - 3600;
    return { time: now + seconds * 1000, price: priceAt(seconds) };
  }).filter((sample) => !missing.includes(sample.time));
  return { samples, current: samples.at(-1), receivedAt: now };
}

test('one missing interior second retains observed minute-close dynamics without filling the gap', () => {
  const complete = history();
  const incomplete = history({ missing: [NOW - 19_000] });
  const before = JSON.stringify(incomplete);
  const full = getBenchmarkConditions({ benchmark: complete, now: NOW });
  const result = getBenchmarkConditions({ benchmark: incomplete, now: NOW });
  expect(result.available).toBe(true);
  expect(result.features).toMatchObject({
    completedCandleCount: 60,
    completeMinuteCount: 59,
    partialMinuteCount: 1,
    observedSecondCount: 3599,
    expectedSecondCount: 3600,
    missingSecondCount: 1,
    rangeSource: 'observed-readings-only',
  });
  for (const key of [
    'logReturn1Minute',
    'logReturn3Minutes',
    'logReturn15Minutes',
    'ewmaMinuteVolatility',
    'effectiveMinuteVolatility',
  ]) {
    expect(result.features[key]).toBe(full.features[key]);
  }
  expect(JSON.stringify(incomplete)).toBe(before);
  expect(incomplete.samples.some((sample) => sample.time === NOW - 19_000)).toBe(false);
});

test.each([
  ['two interior seconds', [NOW - 19_000, NOW - 20_000]],
  ['a minute-close endpoint', [NOW - MINUTE]],
  ['a longer outage', Array.from({ length: 10 }, (_, index) => NOW - (index + 10) * 1000)],
])('does not conceal %s', (_, missing) => {
  const result = getBenchmarkConditions({ benchmark: history({ missing }), now: NOW });
  expect(result.available).toBe(false);
  expect(result.reason).toMatch(/observed closes and 59 of 60 seconds/);
});

test('partial-minute ranges contain only actual observed prices', () => {
  const priceAt = (seconds) => (seconds === -19 ? 101_000 : 100_000);
  const complete = getBenchmarkConditions({ benchmark: history({ priceAt }), now: NOW });
  const incomplete = getBenchmarkConditions({
    benchmark: history({ priceAt, missing: [NOW - 19_000] }),
    now: NOW,
  });
  expect(complete.features.latestCandleLogRange).toBeGreaterThan(0);
  expect(incomplete.features.latestCandleLogRange).toBe(0);
  expect(incomplete.features.partialMinuteCount).toBe(1);
  expect(incomplete.features.rangeSource).toBe('observed-readings-only');
});

test('a missing older endpoint limits the usable history without joining returns across the gap', () => {
  const result = getBenchmarkConditions({
    benchmark: history({ missing: [NOW - 20 * MINUTE] }),
    now: NOW,
  });
  expect(result.available).toBe(true);
  expect(result.features.completedCandleCount).toBe(20);
  expect(result.features.logReturn15Minutes).toBeCloseTo(15 * 60 * 0.000002, 10);
});

test('legacy replay retains strict coverage, original features and unchanged parameter metadata', () => {
  const benchmark = history();
  const current = getBenchmarkConditions({ benchmark, now: NOW });
  const legacy = getBenchmarkConditions({
    benchmark,
    now: NOW,
    allowSparseInteriorReadings: false,
  });
  const {
    completeMinuteCount,
    partialMinuteCount,
    observedSecondCount,
    expectedSecondCount,
    missingSecondCount,
    rangeSource,
    ...unchangedFeatures
  } = current.features;
  expect(legacy.features).toEqual(unchangedFeatures);
  expect(legacy.parameters).toEqual(BENCHMARK_CONDITION_PARAMETERS);
  expect(
    getBenchmarkConditions({
      benchmark: history({ missing: [NOW - 19_000] }),
      now: NOW,
      allowSparseInteriorReadings: false,
    }),
  ).toMatchObject({
    available: false,
    reason: 'At least 16 complete, consecutive BRTI minutes are required.',
  });
});

test('valid current jumps still widen volatility immediately with sparse history', () => {
  const now = NOW + 30_000;
  const benchmark = history({ now, missing: [NOW - 19_000] });
  const quiet = getBenchmarkConditions({ benchmark, now });
  const current = { ...benchmark.current, price: benchmark.current.price * Math.exp(0.003) };
  const jumping = getBenchmarkConditions({
    benchmark: { ...benchmark, current, samples: [...benchmark.samples.slice(0, -1), current] },
    now,
  });
  expect(jumping.available).toBe(true);
  expect(jumping.features.currentJumpElapsedMinutes).toBe(0.5);
  expect(jumping.features.effectiveMinuteVolatility).toBeGreaterThan(
    quiet.features.effectiveMinuteVolatility,
  );
  expect(jumping.riskFlags.some((flag) => flag.code === 'current-price-jump')).toBe(true);
});

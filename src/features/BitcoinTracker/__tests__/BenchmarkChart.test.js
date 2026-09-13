import {
  getBenchmarkChartData,
  getBenchmarkSettlement,
  mergeBenchmarkChartHistory,
} from '../utils/benchmarkChart.utils';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 13, 12);
const DEADLINE = START + 15 * MINUTE;

const reading = (time, price = 50_000) => ({ time, price });
const minuteReadings = (start = START) =>
  Array.from({ length: 60 }, (_, index) => reading(start + (index + 1) * 1_000, 100 + index));
const benchmark = (samples, extra = {}) => ({ available: true, samples, ...extra });
const settlementReadings = () =>
  Array.from({ length: 60 }, (_, index) => reading(DEADLINE - (59 - index) * 1_000, index + 1));

describe('BRTI chart observations', () => {
  test('sorts observed history and includes the current reading without duplicating it', () => {
    const samples = [reading(START + 2_000, 102), reading(START + 1_000, 101)];
    const result = getBenchmarkChartData(
      benchmark(samples, { current: reading(START + 2_000, 102) }),
      START + 3_000,
    );

    expect(result.readings).toEqual([reading(START + 1_000, 101), reading(START + 2_000, 102)]);
    expect(result.current).toEqual(reading(START + 2_000, 102));
    expect(result).toMatchObject({ isFresh: true, status: 'live', reason: null });
  });

  test('excludes invalid, future, subsecond and conflicting readings', () => {
    const result = getBenchmarkChartData(
      benchmark(
        [
          null,
          reading(START, 100),
          reading(START + 1_000, NaN),
          reading(START + 2_000, -1),
          reading(START + 3_000, '103'),
          reading(START + 3_500, 103.5),
          reading(START + 4_000, Infinity),
          reading(START + 5_000, 105),
          reading(START + 6_000, 106),
          reading(START + 7_000, 107),
        ],
        { current: reading(START + 6_000, 999) },
      ),
      START + 6_000,
    );

    expect(result.readings).toEqual([reading(START, 100), reading(START + 5_000, 105)]);
    expect(result.current).toEqual(reading(START + 5_000, 105));
  });

  test.each([undefined, null, 0, -1, NaN, Infinity, START + 0.5])(
    'has a deterministic empty state for invalid clock %p',
    (now) => {
      const result = getBenchmarkChartData(benchmark(minuteReadings()), now);
      expect(result).toMatchObject({
        readings: [],
        candles: [],
        current: null,
        isFresh: false,
        status: 'unavailable',
        priceChange: null,
      });
    },
  );

  test('preserves observed history during an outage without marking it live', () => {
    const result = getBenchmarkChartData(
      benchmark([reading(START)], { available: false, reason: 'The index feed is offline.' }),
      START + 1_000,
    );
    expect(result).toMatchObject({
      readings: [reading(START)],
      current: reading(START),
      isFresh: false,
      status: 'stale',
      reason: 'The index feed is offline.',
    });
  });

  test('freshness expires after five seconds despite a previously live response', () => {
    const data = benchmark([reading(START)]);
    expect(getBenchmarkChartData(data, START + 5_000).isFresh).toBe(true);
    expect(getBenchmarkChartData(data, START + 5_001)).toMatchObject({
      isFresh: false,
      status: 'stale',
    });
  });

  test('uses a real preceding ~15-minute reading and returns fractional change', () => {
    const samples = [reading(START - 2_000, 100), reading(START + 15 * MINUTE, 102)];
    expect(getBenchmarkChartData(benchmark(samples), START + 15 * MINUTE).priceChange).toBeCloseTo(
      0.02,
    );
  });

  test('does not substitute a later or overly old observation for the 15-minute comparison', () => {
    const current = reading(START + 15 * MINUTE, 102);
    const result = getBenchmarkChartData(
      benchmark([reading(START - 6_000, 100), reading(START + 1_000, 101), current]),
      current.time,
    );
    expect(result.priceChange).toBeNull();
  });

  test('does not fall back to a Coinbase ticker or candle', () => {
    const result = getBenchmarkChartData(
      { ticker: reading(START, 99_999), candles: [{ time: START, close: 99_999 }] },
      START,
    );
    expect(result.readings).toEqual([]);
    expect(result.current).toBeNull();
    expect(result.candles).toEqual([]);
  });
});

describe('older BRTI chart history', () => {
  test('sorts and deduplicates backfilled readings while the current feed wins overlaps', () => {
    const now = START + 4 * 60 * MINUTE;
    const live = getBenchmarkChartData(
      benchmark([reading(now - 30 * MINUTE, 50_010), reading(now, 50_020)]),
      now,
    );
    const historical = {
      samples: [
        reading(now - 30 * MINUTE, 999),
        reading(now - 90 * MINUTE, 49_990),
        reading(now, 999),
        reading(now - 90 * MINUTE, 49_990),
        reading(now - 2 * 60 * MINUTE, 49_980),
      ],
    };
    const result = mergeBenchmarkChartHistory(live, historical, now, 120);
    expect(result.readings).toEqual([
      reading(now - 2 * 60 * MINUTE, 49_980),
      reading(now - 90 * MINUTE, 49_990),
      reading(now - 30 * MINUTE, 50_010),
      reading(now, 50_020),
    ]);
    expect(result.current).toEqual(live.current);
    expect(result).toMatchObject({ isFresh: true, status: 'live' });
  });

  test('retains only valid exact-second observations inside the selected history window', () => {
    const now = START + 4 * 60 * MINUTE;
    const oldest = now - 120 * MINUTE;
    const live = getBenchmarkChartData(benchmark([reading(oldest - 1000), reading(now)]), now);
    const result = mergeBenchmarkChartHistory(
      live,
      {
        samples: [
          null,
          reading(oldest - 1000),
          reading(oldest, 100),
          reading(oldest + 500, 101),
          reading(oldest + 1000, -1),
          reading(oldest + 2000, NaN),
          reading(oldest + 3000, '100'),
          reading(oldest + 4000, 104),
          reading(oldest + 5000, 105),
          reading(oldest + 5000, 999),
          reading(now + 1000, 200),
        ],
      },
      now,
      120,
    );
    expect(result.readings).toEqual([
      reading(oldest, 100),
      reading(oldest + 4000, 104),
      reading(now),
    ]);
  });

  test('creates candles only for observed minutes and leaves historical gaps incomplete', () => {
    const now = START + 4 * 60 * MINUTE;
    const historicalStart = now - 90 * MINUTE;
    const samples = [
      reading(historicalStart + 1000, 100),
      reading(historicalStart + 3000, 110),
      reading(historicalStart + 2 * MINUTE + 1000, 90),
    ];
    const live = getBenchmarkChartData(benchmark([reading(now, 105)]), now);
    const result = mergeBenchmarkChartHistory(live, { samples }, now, 120);
    expect(result.readings).toEqual([...samples, reading(now, 105)]);
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0]).toMatchObject({
      time: historicalStart,
      firstSampleAt: historicalStart + 1000,
      lastSampleAt: historicalStart + 3000,
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      sampleCount: 2,
      isPartial: true,
    });
    expect(result.candles[1].time).toBe(historicalStart + 2 * MINUTE);
    expect(result.candles.every((candle) => !candle.isComplete)).toBe(true);
  });

  test('historical availability and a recent response cannot make an offline live feed fresh', () => {
    const live = getBenchmarkChartData(
      benchmark([reading(START - 1000)], { available: false, reason: 'Live index unavailable.' }),
      START,
    );
    const historical = {
      samples: [reading(START, 50_100)],
      available: true,
      status: 'available',
      receivedAt: START,
    };
    const result = mergeBenchmarkChartHistory(live, historical, START, 240);
    expect(result.current).toEqual(reading(START, 50_100));
    expect(result).toMatchObject({
      isFresh: false,
      status: 'stale',
      reason: 'Live index unavailable.',
      priceChange: live.priceChange,
    });
    expect(mergeBenchmarkChartHistory(undefined, historical, START, 240)).toMatchObject({
      isFresh: false,
      status: 'stale',
      priceChange: null,
    });
  });

  test('does not recalculate the headline change or mutate the live snapshot using older history', () => {
    const samples = Object.freeze([Object.freeze(reading(START, 102))]);
    const live = Object.freeze(getBenchmarkChartData(benchmark(samples), START));
    const historical = Object.freeze({
      samples: Object.freeze([Object.freeze(reading(START - 15 * MINUTE, 100))]),
    });
    const result = mergeBenchmarkChartHistory(live, historical, START, 120);
    expect(result.priceChange).toBeNull();
    expect(result.readings).toEqual([reading(START - 15 * MINUTE, 100), reading(START, 102)]);
    expect(live.readings).toEqual([reading(START, 102)]);
    expect(live.current).toEqual(reading(START, 102));
    expect(live.priceChange).toBeNull();
    expect(historical.samples).toEqual([reading(START - 15 * MINUTE, 100)]);
  });

  test.each([undefined, { status: 'unavailable', samples: [] }])(
    'preserves live history when older data is missing: %p',
    (history) => {
      const live = getBenchmarkChartData(benchmark(minuteReadings()), START + MINUTE);
      const result = mergeBenchmarkChartHistory(live, history, START + MINUTE, 120);
      expect(result).toEqual(live);
    },
  );
});

describe('observed BRTI candles', () => {
  test('constructs open, high, low and close in time order inside (start, end]', () => {
    const samples = [
      reading(START + MINUTE, 102),
      reading(START + 2_000, 105),
      reading(START, 1_000),
      reading(START + 3_000, 98),
      reading(START + 1_000, 100),
      reading(START + MINUTE + 1_000, 104),
    ];
    const result = getBenchmarkChartData(benchmark(samples), START + MINUTE + 1_000);
    expect(result.candles).toHaveLength(3);
    expect(result.candles[1]).toEqual({
      time: START,
      endTime: START + MINUTE,
      firstSampleAt: START + 1_000,
      lastSampleAt: START + MINUTE,
      open: 100,
      high: 105,
      low: 98,
      close: 102,
      sampleCount: 4,
      expectedSampleCount: 60,
      isComplete: false,
      isPartial: true,
    });
    expect(result.candles[0].close).toBe(1_000);
    expect(result.candles[2].open).toBe(104);
  });

  test('marks exactly sixty unique observed seconds as complete', () => {
    const samples = minuteReadings();
    const result = getBenchmarkChartData(
      benchmark([...samples, samples[0]], { current: samples.at(-1) }),
      START + MINUTE,
    );
    expect(result.candles).toEqual([
      expect.objectContaining({
        open: 100,
        close: 159,
        high: 159,
        low: 100,
        sampleCount: 60,
        expectedSampleCount: 60,
        isComplete: true,
        isPartial: false,
      }),
    ]);
  });

  test('marks a historical gap and the current incomplete minute as partial without padding', () => {
    const samples = [
      ...minuteReadings().filter((_, index) => index !== 20),
      reading(START + MINUTE + 1_000),
    ];
    const result = getBenchmarkChartData(benchmark(samples), START + MINUTE + 20_000);
    expect(
      result.candles.map(({ sampleCount, isPartial }) => ({ sampleCount, isPartial })),
    ).toEqual([
      { sampleCount: 59, isPartial: true },
      { sampleCount: 1, isPartial: true },
    ]);
    expect(result.readings).toHaveLength(60);
  });

  test('does not generate an empty minute or mutate incoming observations', () => {
    const first = Object.freeze(reading(START + 1_000, 100));
    const last = Object.freeze(reading(START + 3 * MINUTE + 1_000, 103));
    const samples = Object.freeze([first, last]);
    const result = getBenchmarkChartData(benchmark(samples), last.time);
    expect(result.candles).toHaveLength(2);
    expect(result.candles.map(({ time }) => time)).toEqual([START, START + 3 * MINUTE]);
    expect(samples).toEqual([first, last]);
  });
});

describe('observed final-minute BRTI settlement average', () => {
  test('includes deadline - 59 seconds through the deadline and excludes neighboring observations', () => {
    const result = getBenchmarkSettlement(
      [
        reading(DEADLINE - MINUTE, 9_999),
        ...settlementReadings(),
        reading(DEADLINE + 1_000, 9_999),
      ],
      DEADLINE,
      DEADLINE + 1_000,
    );
    expect(result).toMatchObject({
      sampleCount: 60,
      expectedSampleCount: 60,
      elapsedSampleCount: 60,
      average: 30.5,
      isComplete: true,
      isInProgress: false,
      missingSampleCount: 0,
    });
    expect(result.points[0]).toEqual({ time: DEADLINE - 59_000, price: 1, sampleCount: 1 });
    expect(result.points.at(-1)).toEqual({ time: DEADLINE, price: 30.5, sampleCount: 60 });
  });

  test('shows only an observed running average while the final minute is in progress', () => {
    const result = getBenchmarkSettlement(settlementReadings(), DEADLINE, DEADLINE - 30_000);
    expect(result).toMatchObject({
      sampleCount: 30,
      elapsedSampleCount: 30,
      average: 15.5,
      isInProgress: true,
      isComplete: false,
      missingSampleCount: 0,
    });
    expect(result.points.at(-1)).toEqual({
      time: DEADLINE - 30_000,
      price: 15.5,
      sampleCount: 30,
    });
  });

  test('counts elapsed missing slots without interpolating a cumulative point', () => {
    const result = getBenchmarkSettlement(
      [reading(DEADLINE - 59_000, 100), reading(DEADLINE - 57_000, 106)],
      DEADLINE,
      DEADLINE - 56_500,
    );
    expect(result).toMatchObject({
      sampleCount: 2,
      elapsedSampleCount: 3,
      average: 103,
      missingSampleCount: 1,
      isComplete: false,
    });
    expect(result.points).toEqual([
      { time: DEADLINE - 59_000, price: 100, sampleCount: 1 },
      { time: DEADLINE - 57_000, price: 103, sampleCount: 2 },
    ]);
  });

  test('retains an incomplete observed average after expiry instead of declaring a result', () => {
    const result = getBenchmarkSettlement([reading(DEADLINE, 101)], DEADLINE, DEADLINE + MINUTE);
    expect(result).toMatchObject({
      average: 101,
      sampleCount: 1,
      elapsedSampleCount: 60,
      missingSampleCount: 59,
      isComplete: false,
      isInProgress: false,
    });
  });

  test('withholds an average before the window and before its first actual second', () => {
    expect(
      getBenchmarkSettlement(settlementReadings(), DEADLINE, DEADLINE - MINUTE - 1),
    ).toMatchObject({
      points: [],
      average: null,
      sampleCount: 0,
      elapsedSampleCount: 0,
      isInProgress: false,
    });
    expect(getBenchmarkSettlement(settlementReadings(), DEADLINE, DEADLINE - MINUTE)).toMatchObject(
      {
        points: [],
        average: null,
        sampleCount: 0,
        elapsedSampleCount: 0,
        isInProgress: true,
      },
    );
  });

  test('cannot inflate completeness using duplicates, conflicts or subsecond readings', () => {
    const samples = settlementReadings();
    const result = getBenchmarkSettlement(
      [...samples, samples[0], reading(DEADLINE, 999), reading(DEADLINE - 500, 60)],
      DEADLINE,
      DEADLINE,
    );
    expect(result).toMatchObject({ sampleCount: 59, missingSampleCount: 1, isComplete: false });
    expect(result.average).toBe(30);
  });

  test.each([undefined, null, 0, NaN, DEADLINE + 500])(
    'rejects invalid deadline %p',
    (deadline) => {
      expect(getBenchmarkSettlement(settlementReadings(), deadline, DEADLINE)).toMatchObject({
        points: [],
        average: null,
        sampleCount: 0,
        isComplete: false,
      });
    },
  );
});

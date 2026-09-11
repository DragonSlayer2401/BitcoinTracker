import {
  getKalshiForecast,
  KALSHI_MODEL_VERSION,
  KALSHI_MODEL_PARAMETERS,
} from '../utils/kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { getPressureForecast, PRESSURE_MODEL_VERSION } from '../utils/pressureForecast.utils';
import { getBenchmarkConditions } from '../utils/kalshi/benchmarkConditions.utils';

const START = Date.UTC(2026, 8, 10, 12);
const END = START + 900_000;
const MINUTE = 60_000;

function contract(target = 50_000) {
  return {
    ticker: 'KXBTC15M-26SEP101215-15',
    eventTicker: 'KXBTC15M-26SEP101215',
    seriesTicker: 'KXBTC15M',
    startsAt: START,
    expiresAt: END,
    target,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
}

function market(now = END - 5 * MINUTE, options = {}) {
  const minute = Math.floor(now / MINUTE) * MINUTE;
  let price = 50_000;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price;
    price *= Math.exp(index % 2 ? 0.001 : -0.001);
    return {
      time: minute - (120 - index) * MINUTE,
      open,
      high: Math.max(open, price) * 1.0001,
      low: Math.min(open, price) / 1.0001,
      close: price,
      volume: 10,
    };
  });
  return {
    now,
    candles,
    ticker: { price, bid: price - 0.5, ask: price + 0.5, volume: 100, time: now, receivedAt: now },
    horizonMinutes: (END - now) / MINUTE,
    target: 50_000,
    expiresAt: END,
    kalshiMarket: contract(),
    benchmark: {
      status: 'live',
      current: { time: now, price: 50_000 },
      samples: [],
      receivedAt: now,
    },
    ...options,
  };
}

function stream(now, direction = 1, scale = 1) {
  const completeSince = now - 240_000;
  return {
    status: 'live',
    quality: { available: true, heartbeatAt: now, completeSince, confirmedThrough: now },
    flow: {
      impact: {
        available: true,
        asOf: now,
        completeSince,
        confirmedThrough: now,
        bucketSeconds: 15,
        samples: Array.from({ length: 12 }, (_, index) => {
          const signed = index % 2 ? 2 : -2;
          return {
            startAt: now - (12 - index) * 15_000,
            endAt: now - (11 - index) * 15_000,
            startPrice: 50_000,
            endPrice: 50_000 * Math.exp(signed * 0.00005),
            buyBtc: signed > 0 ? 3 : 1,
            sellBtc: signed > 0 ? 1 : 3,
            tradeCount: 20,
          };
        }),
      },
      windows: Object.fromEntries(
        [15, 60, 180].map((seconds) => {
          const buyBtc = ((direction > 0 ? 3 : 1) * scale * seconds) / 15;
          const sellBtc = ((direction > 0 ? 1 : 3) * scale * seconds) / 15;
          return [
            seconds,
            {
              available: true,
              tradeCount: (20 * seconds) / 15,
              buyBtc,
              sellBtc,
              totalBtc: buyBtc + sellBtc,
              signedBtc: buyBtc - sellBtc,
              imbalance: (buyBtc - sellBtc) / (buyBtc + sellBtc),
            },
          ];
        }),
      ),
    },
    liquidity: { available: false },
  };
}

function samples(count, price = 50_000) {
  return Array.from({ length: count }, (_, index) => ({ time: END - (59 - index) * 1000, price }));
}

function benchmarkHistory(
  now,
  priceAtMinute = (minutes) => 50_000 * Math.exp(0.00005 * (Math.cos(Math.PI * minutes) - 1)),
) {
  const minuteEnd = Math.floor(now / MINUTE) * MINUTE;
  const start = minuteEnd - 60 * MINUTE;
  const history = Array.from({ length: (now - start) / 1000 + 1 }, (_, index) => {
    const time = start + index * 1000;
    return { time, price: priceAtMinute((time - minuteEnd) / MINUTE) };
  });
  return { status: 'live', current: history.at(-1), samples: history, receivedAt: now };
}

describe('Kalshi final-minute settlement model', () => {
  test('binds the official target and close time instead of a stale editable preview', () => {
    const input = market(END - 2 * MINUTE, {
      target: 49_000,
      expiresAt: END + 5 * MINUTE,
      horizonMinutes: 7,
    });
    const forecast = getResearchForecast(input);
    expect(forecast).toMatchObject({
      available: true,
      modelVersion: KALSHI_MODEL_VERSION,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      target: 50_000,
      expiresAt: END,
      horizonMinutes: 2,
      intervalAvailable: false,
      kalshi: { marketTicker: contract().ticker, referenceSource: 'cf-brti', approximate: true },
    });
    expect(forecast.learningFeatures.target).toBe(50_000);
    expect(forecast.learningFeatures.expiresAt).toBe(END);
  });

  test('uses shared Brownian increments across the 60 future samples rather than independent ticks', () => {
    const input = market(END - MINUTE);
    const base = getPressureForecast(input);
    const forecast = getKalshiForecast(input, base);
    const sigma = base.pressure.components.minuteVolatility;
    let covariance = 0;
    for (let left = 1; left <= 60; left += 1) {
      for (let right = 1; right <= 60; right += 1) covariance += Math.min(left, right) / 60;
    }
    const correlatedSmallMoveDeviation = 50_000 * sigma * Math.sqrt(covariance / 3600);
    expect(forecast.kalshi.settlementStandardDeviation / correlatedSmallMoveDeviation).toBeCloseTo(
      1,
      4,
    );
    const independentTickDeviation = (50_000 * sigma) / Math.sqrt(60);
    expect(forecast.kalshi.settlementStandardDeviation).toBeGreaterThan(
      independentTickDeviation * 4,
    );
    expect(forecast.kalshi.observedSampleCount).toBe(0);
    expect(forecast.kalshi.futureSampleCount).toBe(60);
  });

  test('conditions on the accumulated average even when the latest benchmark crossed above target', () => {
    const now = END - 30_000;
    const history = samples(30, 49_700);
    history[29].price = 50_100;
    const forecast = getKalshiForecast(
      market(now, {
        benchmark: { status: 'live', samples: history, current: history[29], receivedAt: now },
      }),
    );
    expect(forecast.available).toBe(true);
    expect(forecast.kalshi.referencePrice).toBeGreaterThan(50_000);
    expect(forecast.aboveProbability).toBeLessThan(0.1);
    expect(forecast.kalshi).toMatchObject({
      observedSampleCount: 30,
      missingElapsedSampleCount: 0,
      futureSampleCount: 30,
    });
    expect(forecast.kalshi.requiredFutureAverage).toBeGreaterThan(50_100);
  });

  test('the last-minute start is excluded and the deadline itself remains one future reading', () => {
    const now = END - 1000;
    const history = [{ time: END - MINUTE, price: 1 }, ...samples(59)];
    const forecast = getKalshiForecast(
      market(now, {
        benchmark: { samples: history, current: history.at(-1), receivedAt: now },
      }),
    );
    expect(forecast.kalshi).toMatchObject({
      observedSampleCount: 59,
      missingElapsedSampleCount: 0,
      futureSampleCount: 1,
    });
    expect(forecast.kalshi.expectedSettlementAverage).toBeCloseTo(50_000, 2);
  });

  test('retains uncertainty for missing elapsed history instead of treating it as observed at a late join', () => {
    const now = END - 1000;
    const incomplete = getKalshiForecast(market(now));
    const complete = getKalshiForecast(
      market(now, {
        benchmark: { samples: samples(59), current: { time: now, price: 50_000 } },
      }),
    );
    expect(incomplete.kalshi).toMatchObject({
      observedSampleCount: 1,
      missingElapsedSampleCount: 58,
      futureSampleCount: 1,
      requiredFutureAverage: null,
    });
    expect(incomplete.kalshi.settlementStandardDeviation).toBeGreaterThan(
      complete.kalshi.settlementStandardDeviation * 20,
    );
    expect(complete.kalshi.settlementStandardDeviation).toBeGreaterThan(0);
  });

  test('interpolating between real endpoints leaves the missing reading uncertain and unobserved', () => {
    const now = END - 1000;
    const history = samples(59);
    const sparse = history.filter((_, index) => index !== 28);
    const complete = getKalshiForecast(
      market(now, { benchmark: { samples: history, current: history.at(-1) } }),
    );
    const incomplete = getKalshiForecast(
      market(now, { benchmark: { samples: sparse, current: sparse.at(-1) } }),
    );
    expect(incomplete.kalshi).toMatchObject({
      observedSampleCount: 58,
      missingElapsedSampleCount: 1,
    });
    expect(incomplete.kalshi.settlementStandardDeviation).toBeGreaterThan(
      complete.kalshi.settlementStandardDeviation,
    );
  });

  test('missing benchmark still produces a labeled estimate and shared basis uncertainty persists at expiry', () => {
    const input = market(END - 1, {
      benchmark: { status: 'not-configured', samples: [], current: null },
    });
    const forecast = getKalshiForecast(input);
    expect(forecast).toMatchObject({
      available: true,
      kalshi: {
        referenceSource: 'coinbase-proxy',
        observedSampleCount: 0,
        missingElapsedSampleCount: 59,
        futureSampleCount: 1,
        basisLogDeviation: KALSHI_MODEL_PARAMETERS.minimumProxyBasisLogDeviation,
      },
    });
    expect(forecast.kalshi.settlementStandardDeviation).toBeGreaterThan(
      50_000 * KALSHI_MODEL_PARAMETERS.minimumProxyBasisLogDeviation,
    );
    expect(forecast.kalshi.warning).toMatch(/proxy/i);
    expect(forecast.aboveProbability + forecast.belowProbability).toBe(1);
  });

  test('a stale benchmark becomes a proxy estimate and index disagreement increases basis uncertainty', () => {
    const now = END - MINUTE;
    const forecast = getKalshiForecast(
      market(now, {
        benchmark: { current: { time: now - 10_000, price: 49_800 }, samples: [] },
      }),
    );
    expect(forecast.kalshi.referenceSource).toBe('coinbase-proxy');
    expect(forecast.kalshi.basisLogDeviation).toBeGreaterThan(0.003);
    expect(forecast.kalshi.observedSampleCount).toBe(0);
  });

  test('future readings and conflicting duplicates cannot become settled observations', () => {
    const now = END - 30_000;
    const forecast = getKalshiForecast(
      market(now, {
        benchmark: {
          samples: [
            { time: now - 1000, price: 49_000 },
            { time: now - 1000, price: 51_000 },
            { time: END, price: 1 },
          ],
          current: { time: now, price: 50_000 },
        },
      }),
    );
    expect(forecast.kalshi).toMatchObject({
      observedSampleCount: 1,
      missingElapsedSampleCount: 29,
      futureSampleCount: 30,
    });
    expect(forecast.kalshi.expectedSettlementAverage).toBeGreaterThan(49_990);
  });

  test('cent rounding and YES equality move the continuous boundary half a cent below the target', () => {
    const now = END - 1;
    const input = market(now, {
      benchmark: { samples: samples(59), current: { time: now, price: 50_000 } },
    });
    const atTarget = getKalshiForecast(input);
    const nextCent = getKalshiForecast({ ...input, kalshiMarket: contract(50_000.01) });
    expect(atTarget.aboveProbability).toBeGreaterThan(0.8);
    expect(nextCent.aboveProbability).toBeLessThan(0.2);
  });

  test('executed buying and selling adjust the Kalshi probability without blocking a weak call', () => {
    const now = END - 5 * MINUTE;
    const input = market(now);
    const priceOnly = getKalshiForecast(input);
    const buy = getKalshiForecast({ ...input, stream: stream(now, 1) });
    const sell = getKalshiForecast({ ...input, stream: stream(now, -1) });
    const smallerBuy = getKalshiForecast({ ...input, stream: stream(now, 1, 0.2) });
    expect(buy.pressure.applied).toBe(true);
    expect(sell.pressure.applied).toBe(true);
    expect(sell.available).toBe(true);
    expect(buy.aboveProbability).toBeGreaterThan(smallerBuy.aboveProbability);
    expect(smallerBuy.aboveProbability).toBeGreaterThan(priceOnly.aboveProbability);
    expect(sell.aboveProbability).toBeLessThan(priceOnly.aboveProbability);
    expect(priceOnly.available).toBe(true);
  });

  test('uses index volatility instead of venue volatility once genuine index history is present', () => {
    const input = market();
    const candleBased = getKalshiForecast(input);
    const benchmark = benchmarkHistory(input.now);
    const native = getKalshiForecast({ ...input, benchmark });
    const withoutCoinbase = getKalshiForecast({ ...input, benchmark, ticker: null, candles: [] });
    expect(native.kalshi).toMatchObject({
      priceDynamicsSource: 'cf-brti-history',
      volatilitySource: 'cf-brti',
      referenceReceivedAt: input.now,
      benchmarkConditions: {
        available: true,
        features: { completedCandleCount: 60, latestCompletedAt: input.now },
      },
    });
    expect(native.kalshi.minuteVolatility).toBeLessThan(candleBased.kalshi.minuteVolatility / 5);
    expect(native.kalshi.settlementStandardDeviation).toBeLessThan(
      candleBased.kalshi.settlementStandardDeviation / 5,
    );
    expect(withoutCoinbase.available).toBe(true);
    expect(withoutCoinbase.pressure.applied).toBe(false);
    expect(withoutCoinbase.aboveProbability).toBe(native.aboveProbability);
    expect(withoutCoinbase.kalshi.settlementStandardDeviation).toBe(
      native.kalshi.settlementStandardDeviation,
    );
  });

  test('a smooth index selloff retains movement in uncertainty and exposes real index momentum', () => {
    const input = market();
    const forecast = getKalshiForecast({
      ...input,
      benchmark: benchmarkHistory(input.now, (minutes) => 50_000 * Math.exp(-0.0002 * minutes)),
    });
    expect(forecast.available).toBe(true);
    expect(forecast.kalshi.minuteVolatility).toBeCloseTo(0.0002, 10);
    expect(forecast.kalshi.benchmarkConditions.features.logReturn3Minutes).toBeCloseTo(-0.0006, 10);
    expect(forecast.kalshi.benchmarkConditions.features.logReturn15Minutes).toBeCloseTo(-0.003, 10);
    expect(forecast.kalshi.benchmarkConditions.features.momentumDirection5Minutes).toBe('down');
    // Recording momentum does not invent a fitted directional effect before outcome validation.
    expect(forecast.pressure.applied).toBe(false);
  });

  test('index intraminute excursions widen uncertainty even with identical minute closes', () => {
    const input = market();
    const quiet = getKalshiForecast({
      ...input,
      benchmark: benchmarkHistory(input.now, () => 50_000),
    });
    const excursions = getKalshiForecast({
      ...input,
      benchmark: benchmarkHistory(
        input.now,
        (minutes) => 50_000 * Math.exp(0.001 * Math.sin(2 * Math.PI * minutes)),
      ),
    });
    expect(quiet.available).toBe(true);
    expect(excursions.kalshi.benchmarkConditions.features.logReturn1Minute).toBeCloseTo(0, 12);
    expect(excursions.kalshi.minuteVolatility).toBeGreaterThan(quiet.kalshi.minuteVolatility * 50);
    expect(excursions.kalshi.settlementStandardDeviation).toBeGreaterThan(
      quiet.kalshi.settlementStandardDeviation * 50,
    );
  });

  test('a current index jump widens uncertainty immediately without changing completed history or blocking', () => {
    const now = END - 4 * MINUTE - 30_000;
    const input = market(now);
    const benchmark = benchmarkHistory(now);
    const quiet = getKalshiForecast({ ...input, benchmark });
    const current = { ...benchmark.current, price: benchmark.current.price * Math.exp(0.003) };
    const jumping = getKalshiForecast({
      ...input,
      benchmark: { ...benchmark, current, samples: [...benchmark.samples.slice(0, -1), current] },
    });
    expect(jumping.available).toBe(true);
    expect(jumping.kalshi.minuteVolatility).toBeGreaterThan(quiet.kalshi.minuteVolatility * 10);
    expect(jumping.kalshi.benchmarkConditions.features.currentJumpElapsedMinutes).toBe(0.5);
    expect(jumping.kalshi.benchmarkConditions.canPublish).toBe(true);
    expect(jumping.kalshi.benchmarkConditions.riskFlags).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'current-price-jump' })]),
    );
    expect(jumping.kalshi.benchmarkConditions.features.logReturn1Minute).toBe(
      quiet.kalshi.benchmarkConditions.features.logReturn1Minute,
    );
  });

  test('future samples cannot affect volatility and a recent missing second keeps the labeled fallback', () => {
    const input = market();
    const benchmark = benchmarkHistory(input.now);
    const native = getKalshiForecast({ ...input, benchmark });
    const withFuture = getKalshiForecast({
      ...input,
      benchmark: { ...benchmark, samples: [...benchmark.samples, { time: END, price: 1 }] },
    });
    const gap = getKalshiForecast({
      ...input,
      benchmark: {
        ...benchmark,
        samples: benchmark.samples.filter((sample) => sample.time !== input.now - 90_000),
      },
    });
    expect(withFuture.kalshi.minuteVolatility).toBe(native.kalshi.minuteVolatility);
    expect(gap.available).toBe(true);
    expect(gap.kalshi).toMatchObject({
      referenceSource: 'cf-brti',
      priceDynamicsSource: 'coinbase-candles',
      benchmarkConditions: { available: false },
    });
    expect(getBenchmarkConditions({ benchmark, now: input.now }).features).not.toHaveProperty(
      'relativeVolume5To30Minutes',
    );
  });

  test('an index move outside the operating range cannot fall back to quiet Coinbase uncertainty', () => {
    const now = END - 30_000;
    const input = market(now);
    const benchmark = benchmarkHistory(now);
    const current = { ...benchmark.current, price: benchmark.current.price * 2 };
    const forecast = getKalshiForecast({
      ...input,
      benchmark: { ...benchmark, current, samples: [...benchmark.samples.slice(0, -1), current] },
    });
    expect(forecast.available).toBe(false);
    expect(forecast.aboveProbability).toBeNull();
    expect(forecast.reason).toMatch(/BRTI volatility.*operating range/);
  });

  test('native-history settlement leaves one true future reading and retains missing-slot bridge uncertainty', () => {
    const now = END - 1000;
    const input = market(now);
    const benchmark = benchmarkHistory(now, () => 50_000);
    const complete = getKalshiForecast({ ...input, benchmark });
    const missing = getKalshiForecast({
      ...input,
      benchmark: {
        ...benchmark,
        samples: benchmark.samples.filter((sample) => sample.time !== END - 30_000),
      },
    });
    const oneSecondPriceDeviation = (50_000 * complete.kalshi.minuteVolatility) / Math.sqrt(60);
    expect(complete.kalshi).toMatchObject({
      priceDynamicsSource: 'cf-brti-history',
      observedSampleCount: 59,
      missingElapsedSampleCount: 0,
      futureSampleCount: 1,
    });
    expect(complete.kalshi.settlementStandardDeviation).toBeCloseTo(
      oneSecondPriceDeviation / 60,
      8,
    );
    expect(missing.kalshi).toMatchObject({
      priceDynamicsSource: 'cf-brti-history',
      observedSampleCount: 58,
      missingElapsedSampleCount: 1,
      futureSampleCount: 1,
      requiredFutureAverage: null,
    });
    expect(missing.kalshi.settlementStandardDeviation).toBeGreaterThan(
      complete.kalshi.settlementStandardDeviation,
    );
  });

  test('the covariance retains the seconds since the actual benchmark timestamp', () => {
    const now = END - MINUTE;
    const input = market(now);
    const fresh = getKalshiForecast(input);
    const aged = getKalshiForecast({
      ...input,
      benchmark: { ...input.benchmark, current: { time: now - 4000, price: 50_000 } },
    });
    let covariance = 0;
    for (let left = 1; left <= 60; left += 1) {
      for (let right = 1; right <= 60; right += 1) covariance += Math.min(left, right) / 60;
    }
    const expectedRatio = Math.sqrt((covariance + (3600 * 4) / 60) / covariance);
    expect(aged.kalshi.referenceAt).toBe(now - 4000);
    expect(
      aged.kalshi.settlementStandardDeviation / fresh.kalshi.settlementStandardDeviation,
    ).toBeCloseTo(expectedRatio, 5);
  });

  test('large executed pressure is bounded by index uncertainty and does not require agreement to publish', () => {
    const now = END - 5 * MINUTE;
    const input = { ...market(now), benchmark: benchmarkHistory(now) };
    const baseline = getKalshiForecast(input);
    const buy = getKalshiForecast({ ...input, stream: stream(now, 1, 100) });
    const sell = getKalshiForecast({ ...input, stream: stream(now, -1, 100) });
    const nativeVolatility = baseline.kalshi.minuteVolatility;
    expect(buy.available).toBe(true);
    expect(sell.available).toBe(true);
    expect(buy.pressure.applied).toBe(true);
    expect(buy.pressure.components.minuteVolatility).toBe(nativeVolatility);
    expect(buy.aboveProbability).toBeGreaterThan(baseline.aboveProbability);
    expect(sell.aboveProbability).toBeLessThan(baseline.aboveProbability);
    expect(
      Math.log(buy.kalshi.expectedSettlementAverage / baseline.kalshi.expectedSettlementAverage),
    ).toBeLessThanOrEqual(nativeVolatility * 0.75 * Math.sqrt(3) + 1e-12);
  });

  test.each([
    ['unverified rules', { kalshiMarket: { ...contract(), rulesVerified: false } }],
    ['wrong comparator', { kalshiMarket: { ...contract(), comparison: 'greater' } }],
    ['expired contract', { now: END }],
    ['future window', { now: START - 1 }],
    ['invalid benchmark and stale Coinbase', { benchmark: null, ticker: null }],
  ])('keeps essential validation for %s', (_, patch) => {
    expect(getKalshiForecast(market(undefined, patch)).available).toBe(false);
  });

  test('missing Kalshi contract cannot fall back to a legacy Coinbase forecast', () => {
    const input = market();
    delete input.kalshiMarket;
    const research = getResearchForecast(input);
    expect(research.modelVersion).toBe(KALSHI_MODEL_VERSION);
    expect(research.available).toBe(false);
    expect(research.aboveProbability).toBeNull();
  });
});

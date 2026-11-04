import { getForecast } from '../utils/forecast.utils';
import {
  getPressureForecast,
  getPressureLocation,
  getPressureVolatility,
  PRESSURE_MODEL_PARAMETERS,
  PRESSURE_MODEL_VERSION,
} from '../utils/pressureForecast.utils';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 15);
const MINUTE = 60_000;
const CURRENT_MINUTE = Math.floor(NOW / MINUTE) * MINUTE;

function createMarket() {
  let price = 50_000;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price;
    price *= Math.exp(index % 2 ? 0.001 : -0.001);
    return {
      time: CURRENT_MINUTE - (120 - index) * MINUTE,
      open,
      high: Math.max(open, price) * 1.0001,
      low: Math.min(open, price) / 1.0001,
      close: price,
      volume: 10,
    };
  });
  return {
    candles,
    ticker: { price, bid: price - 0.5, ask: price + 0.5, volume: 100, time: NOW, receivedAt: NOW },
    target: price,
    now: NOW,
    horizonMinutes: 5,
  };
}

function createStream({ direction = 1, scale = 1, sampleCount = 12 } = {}) {
  const completeSince = NOW - 240_000;
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const signed = index % 2 ? 2 : -2;
    return {
      startAt: NOW - (sampleCount - index) * 15_000,
      endAt: NOW - (sampleCount - index - 1) * 15_000,
      startPrice: 50_000,
      endPrice: 50_000 * Math.exp(signed * 0.00005),
      buyBtc: signed > 0 ? 3 : 1,
      sellBtc: signed > 0 ? 1 : 3,
      tradeCount: 20,
    };
  });
  return {
    status: 'live',
    quality: { available: true, heartbeatAt: NOW, completeSince, confirmedThrough: NOW },
    flow: {
      impact: {
        available: true,
        asOf: NOW,
        completeSince,
        confirmedThrough: NOW,
        bucketSeconds: 15,
        samples,
      },
      windows: Object.fromEntries(
        [15, 60, 180].map((seconds) => {
          const buyBtc = (direction > 0 ? 3 : direction < 0 ? 1 : 2) * scale * (seconds / 15);
          const sellBtc = (direction > 0 ? 1 : direction < 0 ? 3 : 2) * scale * (seconds / 15);
          return [
            seconds,
            {
              available: true,
              tradeCount: 20 * (seconds / 15),
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

function expectBaselineFallback(input) {
  const baseline = getForecast(input);
  const priceBased = getPressureForecast({ ...input, stream: undefined });
  const forecast = getPressureForecast(input);
  expect(forecast).toMatchObject({
    available: baseline.available,
    aboveProbability: priceBased.aboveProbability,
    belowProbability: priceBased.belowProbability,
    lowerBound: priceBased.lowerBound,
    upperBound: priceBased.upperBound,
    volatility: priceBased.volatility,
    sampleCount: baseline.sampleCount,
    modelVersion: PRESSURE_MODEL_VERSION,
    locationLogReturn: 0,
    pressure: {
      applied: false,
      expectedLogReturn: 0,
      adjustmentPercentagePoints: 0,
      baselineAboveProbability: baseline.aboveProbability,
    },
  });
  expect(forecast.pressure.reason).toEqual(expect.any(String));
}

describe('experimental executed-pressure forecast', () => {
  test('buying and selling shift a symmetric market equally in opposite directions', () => {
    const market = createMarket();
    const buying = getPressureForecast({ ...market, stream: createStream() });
    const selling = getPressureForecast({ ...market, stream: createStream({ direction: -1 }) });
    expect(buying.pressure.applied).toBe(true);
    expect(buying.aboveProbability).toBeGreaterThan(0.5);
    expect(selling.aboveProbability).toBeLessThan(0.5);
    expect(buying.aboveProbability + selling.aboveProbability).toBeCloseTo(1, 12);
    expect(buying.pressure.expectedLogReturn).toBeCloseTo(-selling.pressure.expectedLogReturn, 12);
    expect(buying.direction).toBe('above');
    expect(selling.direction).toBe('below');
    expect(buying.pressure.direction).toBe('buy');
    expect(selling.pressure.direction).toBe('sell');
    expect(buying.pressure.adjustmentPercentagePoints).toBeGreaterThan(0);
  });

  test('pressure can favor a recovery while the last price is still below the target', () => {
    const market = createMarket();
    market.target *= Math.exp(0.00005);
    expect(getForecast(market).aboveProbability).toBeLessThan(0.5);
    expect(
      getPressureForecast({ ...market, stream: createStream() }).aboveProbability,
    ).toBeGreaterThan(0.5);
  });

  test('net executed volume affects the shift, while changing trade count alone does not', () => {
    const market = createMarket();
    const small = getPressureForecast({ ...market, stream: createStream({ scale: 0.2 }) });
    const largeStream = createStream({ scale: 1 });
    const large = getPressureForecast({ ...market, stream: largeStream });
    Object.values(largeStream.flow.windows).forEach((window) => {
      window.tradeCount *= 10;
    });
    const split = getPressureForecast({ ...market, stream: largeStream });
    expect(large.pressure.expectedLogReturn).toBeGreaterThan(small.pressure.expectedLogReturn);
    expect(split.aboveProbability).toBe(large.aboveProbability);
  });

  test('short-window conflict offsets sustained flow instead of issuing a veto', () => {
    const market = createMarket();
    const stream = createStream();
    const sustained = getPressureForecast({ ...market, stream });
    stream.flow.windows[15] = createStream({ direction: -1 }).flow.windows[15];
    const conflicting = getPressureForecast({ ...market, stream });
    expect(conflicting.available).toBe(true);
    expect(conflicting.pressure.applied).toBe(true);
    expect(conflicting.pressure.expectedLogReturn).toBeLessThan(
      sustained.pressure.expectedLogReturn,
    );
  });

  test('does not require the 180-second window or a healthy order book', () => {
    const stream = createStream();
    stream.status = 'warming';
    stream.quality.available = false;
    stream.flow.windows[180] = { available: false };
    const forecast = getPressureForecast({ ...createMarket(), stream });
    expect(forecast.pressure.applied).toBe(true);
    expect(forecast.pressure.components.windows).toEqual([
      { seconds: 15, weight: 0.625 },
      { seconds: 60, weight: 0.37499999999999994 },
    ]);
  });

  test('decays pressure instead of extending a short move linearly for fifteen minutes', () => {
    const input = { ...createMarket(), stream: createStream() };
    const minute = getPressureForecast({ ...input, horizonMinutes: 1 });
    const five = getPressureForecast({ ...input, horizonMinutes: 5 });
    const fifteen = getPressureForecast({ ...input, horizonMinutes: 15 });
    const tiny = getPressureForecast({ ...input, horizonMinutes: 0.001 });
    expect(fifteen.pressure.expectedLogReturn).toBeLessThan(
      minute.pressure.expectedLogReturn * 2.01,
    );
    expect(fifteen.pressure.expectedLogReturn).toBeLessThan(five.pressure.expectedLogReturn * 1.04);
    expect(tiny.pressure.expectedLogReturn).toBeLessThan(minute.pressure.expectedLogReturn / 500);
    expect(fifteen.pressure.adjustmentPercentagePoints).toBeLessThan(
      five.pressure.adjustmentPercentagePoints,
    );
  });

  test('bounds extreme flow shifts and keeps complementary finite probabilities', () => {
    for (const direction of [-1, 1]) {
      const forecast = getPressureForecast({
        ...createMarket(),
        stream: createStream({ direction, scale: 1e6 }),
      });
      expect(Math.abs(forecast.pressure.expectedLogReturn)).toBeLessThanOrEqual(
        forecast.pressure.components.maximumLogShift,
      );
      expect(forecast.aboveProbability + forecast.belowProbability).toBe(1);
      expect(forecast.aboveProbability).toBeGreaterThanOrEqual(0.01);
      expect(forecast.aboveProbability).toBeLessThanOrEqual(0.99);
      expect(forecast.pressure.parameters).toEqual(PRESSURE_MODEL_PARAMETERS);
    }
  });

  test('weak or short empirical fits are shrunk more than a longer consistent fit', () => {
    const market = createMarket();
    const short = getPressureForecast({ ...market, stream: createStream({ sampleCount: 6 }) });
    const long = getPressureForecast({ ...market, stream: createStream({ sampleCount: 15 }) });
    const noisyStream = createStream({ sampleCount: 15 });
    noisyStream.flow.impact.samples[0].endPrice = 50_000 * Math.exp(0.001);
    const noisy = getPressureForecast({ ...market, stream: noisyStream });
    expect(short.pressure.reliability).toBeLessThan(long.pressure.reliability);
    expect(noisy.pressure.reliability).toBeLessThan(long.pressure.reliability);
  });

  test('raises uncertainty for wide intraminute ranges and a current jump, without vetoing', () => {
    const market = createMarket();
    const stream = createStream();
    const quiet = getPressureForecast({ ...market, stream });
    const volatile = {
      ...market,
      candles: market.candles.map((candle) => ({
        ...candle,
        high: candle.high * 1.01,
        low: candle.low / 1.01,
      })),
    };
    const wide = getPressureForecast({ ...volatile, stream });
    const jumpPrice = market.ticker.price * 1.01;
    const jump = getPressureForecast({
      ...market,
      ticker: { ...market.ticker, price: jumpPrice, bid: jumpPrice - 0.5, ask: jumpPrice + 0.5 },
      stream,
    });
    expect(wide.available).toBe(true);
    expect(jump.available).toBe(true);
    expect(wide.volatility).toBeGreaterThan(quiet.volatility);
    expect(jump.volatility).toBeGreaterThan(quiet.volatility);
  });

  test('does not remove smooth directional movement when estimating uncertainty', () => {
    const market = createMarket();
    let price = 50_000;
    market.candles = market.candles.map((candle, index) => {
      const open = price;
      price *= Math.exp(0.001 + (index % 2 ? 0.00002 : -0.00002));
      return { ...candle, open, close: price, low: open, high: price };
    });
    market.ticker = { ...market.ticker, price, bid: price - 0.5, ask: price + 0.5 };
    market.target = price;
    const baseline = getForecast(market);
    const forecast = getPressureForecast({ ...market, stream: createStream() });
    expect(forecast.volatility).toBeGreaterThan(baseline.volatility * 20);
  });

  test('a wider spread adds uncertainty and midpoint disagreement is handled mathematically', () => {
    const market = createMarket();
    const stream = createStream({ direction: 0 });
    const tight = getPressureForecast({ ...market, stream });
    const wide = getPressureForecast({
      ...market,
      ticker: { ...market.ticker, bid: market.target - 100, ask: market.target + 100 },
      stream,
    });
    const offset = getPressureForecast({
      ...market,
      ticker: { ...market.ticker, bid: market.target - 100, ask: market.target - 10 },
      stream,
    });
    expect(wide.pressure.applied).toBe(true);
    expect(wide.volatility).toBeGreaterThan(tight.volatility);
    expect(offset.available).toBe(true);
    expect(offset.locationLogReturn).toBeLessThan(0);
    expect(offset.aboveProbability).toBeLessThan(0.5);
  });

  test('centers its interval on the shifted distribution and exposes the same decaying chart path', () => {
    const forecast = getPressureForecast({ ...createMarket(), stream: createStream() });
    const center = Math.sqrt(forecast.lowerBound * forecast.upperBound);
    expect(Math.log(center / createMarket().ticker.price)).toBeCloseTo(
      forecast.locationLogReturn,
      12,
    );
    expect(getPressureLocation(forecast, 0)).toBe(0);
    expect(getPressureLocation(forecast, 1)).toBe(forecast.locationLogReturn);
    expect(getPressureLocation(forecast, 0.5)).toBeGreaterThan(forecast.locationLogReturn / 2);
    expect(getPressureLocation(getPressureForecast(createMarket()), 0.5)).toBe(0);
  });

  test('keeps spread and midpoint uncertainty at shorter chart horizons and matches direct estimates', () => {
    const market = createMarket();
    market.ticker.bid = market.target - 100;
    market.ticker.ask = market.target + 20;
    const input = { ...market, stream: createStream() };
    const full = getPressureForecast({ ...input, horizonMinutes: 10 });
    const half = getPressureForecast({ ...input, horizonMinutes: 5 });
    expect(getPressureVolatility(full, 0)).toBe(0);
    expect(getPressureVolatility(full, 1)).toBe(full.volatility);
    expect(getPressureVolatility(full, 0.5)).toBeCloseTo(half.volatility, 12);
    expect(getPressureVolatility(full, 0.5)).toBeGreaterThan(full.volatility * Math.sqrt(0.5));
    expect(getPressureLocation(full, 0)).toBe(0);
    expect(getPressureLocation(full, 0.5)).toBeCloseTo(half.locationLogReturn, 12);
    const lower =
      market.ticker.price *
      Math.exp(
        getPressureLocation(full, 0.5) - 1.2815515655446004 * getPressureVolatility(full, 0.5),
      );
    const upper =
      market.ticker.price *
      Math.exp(
        getPressureLocation(full, 0.5) + 1.2815515655446004 * getPressureVolatility(full, 0.5),
      );
    expect(lower).toBeCloseTo(half.lowerBound, 8);
    expect(upper).toBeCloseTo(half.upperBound, 8);
  });

  test('uses the same intermediate uncertainty for adaptive fallback and legacy square-root scaling', () => {
    const market = createMarket();
    market.ticker.bid = market.target - 100;
    const full = getPressureForecast({ ...market, horizonMinutes: 10 });
    const half = getPressureForecast({ ...market, horizonMinutes: 5 });
    const legacy = getForecast({ ...market, horizonMinutes: 10 });
    expect(full.pressure.applied).toBe(false);
    expect(getPressureVolatility(full, 0.5)).toBeCloseTo(half.volatility, 12);
    expect(getPressureLocation(full, 0.5)).toBe(half.locationLogReturn);
    expect(getPressureVolatility(legacy, 0.5)).toBe(legacy.volatility * Math.sqrt(0.5));
  });

  test('does not return a zero lower bound when responsive uncertainty underflows', () => {
    const market = createMarket();
    const scale = 1e-300 / market.ticker.price;
    market.candles = market.candles.map((candle) => ({
      ...candle,
      open: candle.open * scale,
      close: candle.close * scale,
      high: candle.high * scale * Math.exp(20),
      low: candle.low * scale * Math.exp(-20),
    }));
    for (const field of ['price', 'bid', 'ask']) market.ticker[field] *= scale;
    market.target *= scale;
    const baseline = getForecast(market);
    expect(baseline.available).toBe(true);
    const forecast = getPressureForecast(market);
    expect(forecast.lowerBound).toBeGreaterThan(0);
    expect(forecast.upperBound).toBeGreaterThan(0);
    expect(forecast.pressure.reason).toContain('cannot be calculated safely');
  });

  test('ignores partial candles without changing probability or pressure estimates', () => {
    const input = { ...createMarket(), stream: createStream() };
    const original = getPressureForecast(input);
    const partial = {
      time: CURRENT_MINUTE,
      open: -1,
      high: NaN,
      low: -10,
      close: 1e9,
      volume: 1e9,
    };
    expect(getPressureForecast({ ...input, candles: [...input.candles, partial] })).toEqual(
      original,
    );
  });

  test('uses a price-based estimate and keeps original baseline probabilities for comparison', () => {
    expectBaselineFallback(createMarket());
    expectBaselineFallback({ ...createMarket(), stream: createStream({ sampleCount: 5 }) });
    const market = createMarket();
    market.target *= 1.00001;
    expect(getPressureForecast(market).direction).toBe('below');
  });

  test('responsive uncertainty still works when flow is absent or its impact fit is nonpositive', () => {
    const market = createMarket();
    market.target *= 0.999;
    market.candles = market.candles.map((candle) => ({
      ...candle,
      high: candle.high * 1.01,
      low: candle.low / 1.01,
    }));
    const original = getForecast(market);
    const missing = getPressureForecast(market);
    const stream = createStream();
    stream.flow.impact.samples.forEach((sample) => {
      sample.endPrice = sample.startPrice;
    });
    const flatFit = getPressureForecast({ ...market, stream });
    expect(missing.available).toBe(true);
    expect(missing.pressure.applied).toBe(false);
    expect(missing.volatility).toBeGreaterThan(original.volatility);
    expect(missing.aboveProbability).toBeLessThan(original.aboveProbability);
    expect(flatFit.volatility).toBe(missing.volatility);
    expect(flatFit.aboveProbability).toBe(missing.aboveProbability);
    expect(missing.pressure.unshiftedAboveProbability).toBe(missing.aboveProbability);
  });

  test('untrusted window fields cannot replace the configured weights or horizon', () => {
    const market = createMarket();
    const stream = createStream();
    const original = getPressureForecast({ ...market, stream });
    stream.flow.windows[15].seconds = 1e-100;
    stream.flow.windows[15].weight = Infinity;
    expect(getPressureForecast({ ...market, stream })).toEqual(original);
  });

  test('does not combine current pressure with an older otherwise-valid REST price', () => {
    const market = createMarket();
    market.ticker.time -= 6000;
    const forecast = getPressureForecast({ ...market, stream: createStream() });
    expect(forecast.available).toBe(true);
    expect(forecast.pressure.applied).toBe(false);
    expect(forecast.pressure.reason).toContain('quote matches recent trade pressure');
  });

  test.each([
    [
      'stale snapshot',
      (stream) => {
        stream.flow.impact.asOf -= 5001;
      },
    ],
    [
      'future snapshot',
      (stream) => {
        stream.flow.impact.asOf += 1;
      },
    ],
    [
      'stale heartbeat',
      (stream) => {
        stream.quality.heartbeatAt -= 5001;
      },
    ],
    [
      'future heartbeat',
      (stream) => {
        stream.quality.heartbeatAt += 1;
      },
    ],
    [
      'missing quality',
      (stream) => {
        delete stream.quality;
      },
    ],
    [
      'reconnecting transport',
      (stream) => {
        stream.status = 'reconnecting';
      },
    ],
    [
      'unverified impact',
      (stream) => {
        stream.flow.impact.available = false;
      },
    ],
    [
      'mismatched continuity',
      (stream) => {
        stream.quality.completeSince += 1;
      },
    ],
    [
      'future impact bucket',
      (stream) => {
        stream.flow.impact.samples.at(-1).endAt += 15_000;
      },
    ],
    [
      'duplicate bucket',
      (stream) => {
        stream.flow.impact.samples[1] = { ...stream.flow.impact.samples[0] };
      },
    ],
    [
      'negative bucket size',
      (stream) => {
        stream.flow.impact.samples[0].buyBtc = -1;
      },
    ],
    [
      'invalid bucket price',
      (stream) => {
        stream.flow.impact.samples[0].endPrice = NaN;
      },
    ],
    [
      'invalid window volume',
      (stream) => {
        stream.flow.windows[15].buyBtc = Infinity;
      },
    ],
    [
      'inconsistent signed volume',
      (stream) => {
        stream.flow.windows[60].signedBtc = -99;
      },
    ],
    [
      'inconsistent imbalance',
      (stream) => {
        stream.flow.windows[180].imbalance = 0.999;
      },
    ],
    [
      'zero trades with volume',
      (stream) => {
        stream.flow.windows[15].tradeCount = 0;
      },
    ],
    [
      'negative count',
      (stream) => {
        stream.flow.windows[15].tradeCount = -1;
      },
    ],
    [
      'no available windows',
      (stream) => {
        stream.flow.windows = {};
      },
    ],
    [
      'no price response',
      (stream) => {
        stream.flow.impact.samples.forEach((sample) => {
          sample.endPrice = sample.startPrice;
        });
      },
    ],
    [
      'negative impact fit',
      (stream) => {
        stream.flow.impact.samples.forEach((sample) => {
          [sample.startPrice, sample.endPrice] = [sample.endPrice, sample.startPrice];
        });
      },
    ],
  ])('uses baseline fallback for %s', (_label, mutate) => {
    const stream = createStream();
    mutate(stream);
    expectBaselineFallback({ ...createMarket(), stream });
  });

  test.each([
    [
      'invalid quote',
      (market) => {
        market.ticker.bid = -1;
      },
    ],
    [
      'stale quote',
      (market) => {
        market.ticker.time -= 21_000;
      },
    ],
    [
      'bad target',
      (market) => {
        market.target = 0;
      },
    ],
    [
      'missing candle',
      (market) => {
        market.candles.splice(80, 1);
      },
    ],
    [
      'invalid closed candle',
      (market) => {
        market.candles[119].volume = -1;
      },
    ],
  ])('preserves essential baseline validation for %s', (_label, mutate) => {
    const market = createMarket();
    mutate(market);
    const forecast = getPressureForecast({ ...market, stream: createStream() });
    expect(forecast.available).toBe(false);
    expect(forecast.modelVersion).toBe(PRESSURE_MODEL_VERSION);
    expect(forecast.aboveProbability).toBeNull();
  });
});

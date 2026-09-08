import { getForecast } from '../utils/forecast.utils';

const MINUTE_IN_MILLISECONDS = 60_000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 15);
const CURRENT_MINUTE = Math.floor(NOW / MINUTE_IN_MILLISECONDS) * MINUTE_IN_MILLISECONDS;

function createMarket({ count = 90, scale = 1, minuteReturns } = {}) {
  const moves = minuteReturns ?? [-0.0011, 0.0017, -0.0008, 0.0002, -0.0004, 0.0009];
  let previousClose = 50_000 * scale;
  const candles = Array.from({ length: count }, (_, index) => {
    const close = previousClose * Math.exp(moves[index % moves.length]);
    const candle = {
      time: CURRENT_MINUTE - (count - index) * MINUTE_IN_MILLISECONDS,
      open: previousClose,
      high: Math.max(previousClose, close) * 1.0002,
      low: Math.min(previousClose, close) * 0.9998,
      close,
      volume: 10,
    };
    previousClose = close;
    return candle;
  });

  return {
    candles,
    ticker: {
      price: previousClose,
      time: NOW - 1_000,
      receivedAt: NOW - 250,
      bid: previousClose - 0.5 * scale,
      ask: previousClose + 0.5 * scale,
      volume: 12_345,
    },
    target: previousClose,
    now: NOW,
  };
}

describe('getForecast', () => {
  test('returns an even neutral baseline at the current price', () => {
    const market = createMarket();
    const forecast = getForecast(market);

    expect(forecast).toEqual({
      available: true,
      reason: null,
      aboveProbability: 0.5,
      belowProbability: 0.5,
      direction: 'neutral',
      volatility: expect.any(Number),
      lowerBound: expect.any(Number),
      upperBound: expect.any(Number),
      sampleCount: 89,
      horizonMinutes: 15,
      modelVersion: 'zero-drift-log-return-v1',
    });
    expect(forecast.lowerBound).toBeLessThan(market.ticker.price);
    expect(forecast.upperBound).toBeGreaterThan(market.ticker.price);
    expect(Math.sqrt(forecast.lowerBound * forecast.upperBound)).toBeCloseTo(market.ticker.price);
  });

  test('above and below probabilities sum to one and move monotonically with the target', () => {
    const market = createMarket();
    const forecasts = [0.995, 1, 1.005].map((multiplier) =>
      getForecast({ ...market, target: market.ticker.price * multiplier }),
    );

    forecasts.forEach((forecast) => {
      expect(forecast.aboveProbability + forecast.belowProbability).toBe(1);
    });
    expect(forecasts[0].aboveProbability).toBeGreaterThan(forecasts[1].aboveProbability);
    expect(forecasts[1].aboveProbability).toBeGreaterThan(forecasts[2].aboveProbability);
    expect(forecasts.map((forecast) => forecast.direction)).toEqual(['above', 'neutral', 'below']);
  });

  test('caps extreme model probabilities without implying certainty', () => {
    const market = createMarket();
    const lowerTarget = getForecast({ ...market, target: 1 });
    const higherTarget = getForecast({ ...market, target: 1_000_000_000 });

    expect(lowerTarget.aboveProbability).toBe(0.99);
    expect(higherTarget.aboveProbability).toBe(0.01);
    expect(lowerTarget.belowProbability).toBeCloseTo(0.01);
    expect(higherTarget.belowProbability).toBe(0.99);
  });

  test('uses log returns so changing the currency scale preserves probabilities', () => {
    const market = createMarket();
    const scaledMarket = createMarket({ scale: 100 });
    const forecast = getForecast({ ...market, target: market.target * 1.002 });
    const scaledForecast = getForecast({ ...scaledMarket, target: scaledMarket.target * 1.002 });

    expect(scaledForecast.aboveProbability).toBeCloseTo(forecast.aboveProbability, 10);
    expect(scaledForecast.volatility).toBeCloseTo(forecast.volatility, 10);
    expect(scaledForecast.lowerBound).toBeCloseTo(forecast.lowerBound * 100, 6);
    expect(scaledForecast.upperBound).toBeCloseTo(forecast.upperBound * 100, 6);
  });

  test('uses sample volatility and scales it to fifteen minutes', () => {
    const market = createMarket({ count: 61, minuteReturns: [0.001, -0.001] });
    const forecast = getForecast(market);
    const expectedVolatility = Math.sqrt((60 * 0.001 ** 2) / 59) * Math.sqrt(15);

    expect(forecast.volatility).toBeCloseTo(expectedVolatility, 12);
    expect(forecast.sampleCount).toBe(60);
  });

  test('uses the same fifteen-minute forecast when the horizon is omitted or explicit', () => {
    const market = createMarket();

    expect(getForecast(market)).toEqual(getForecast({ ...market, horizonMinutes: 15 }));
    expect(getForecast({ ...market, horizonMinutes: undefined })).toEqual(getForecast(market));
  });

  test('scales volatility and the price interval to the remaining scheduled horizon', () => {
    const market = createMarket();
    const fullForecast = getForecast(market);
    const forecast = getForecast({ ...market, horizonMinutes: 14.8 });
    const scale = Math.sqrt(14.8 / 15);

    expect(forecast.available).toBe(true);
    expect(forecast.horizonMinutes).toBe(14.8);
    expect(forecast.volatility).toBeCloseTo(fullForecast.volatility * scale, 12);
    expect(forecast.lowerBound).toBeCloseTo(
      market.ticker.price * (fullForecast.lowerBound / market.ticker.price) ** scale,
      8,
    );
    expect(forecast.upperBound).toBeCloseTo(
      market.ticker.price * (fullForecast.upperBound / market.ticker.price) ** scale,
      8,
    );
  });

  test('assigns less probability to a price move with one minute remaining', () => {
    const market = createMarket({ count: 61, minuteReturns: [0.001, -0.001] });
    const target = market.ticker.price * Math.exp(Math.sqrt((60 * 0.001 ** 2) / 59));
    const fullForecast = getForecast({ ...market, target });
    const forecast = getForecast({ ...market, target, horizonMinutes: 1 });

    expect(forecast.available).toBe(true);
    expect(forecast.horizonMinutes).toBe(1);
    expect(forecast.volatility).toBeCloseTo(Math.sqrt((60 * 0.001 ** 2) / 59), 12);
    expect(forecast.aboveProbability).toBeCloseTo(0.1586552539, 6);
    expect(forecast.aboveProbability).toBeLessThan(fullForecast.aboveProbability);
    expect(forecast.lowerBound).toBeGreaterThan(fullForecast.lowerBound);
    expect(forecast.upperBound).toBeLessThan(fullForecast.upperBound);
  });

  test.each([0, -1, NaN, Infinity, -Infinity, '15', '14.8', null, true, {}, 15.001, 16])(
    'rejects an invalid horizon without coercion: %s',
    (horizonMinutes) => {
      expect(getForecast({ ...createMarket(), horizonMinutes })).toMatchObject({
        available: false,
        reason: expect.stringMatching(/forecast horizon/),
        aboveProbability: null,
        belowProbability: null,
        volatility: null,
        horizonMinutes: null,
      });
    },
  );

  test('preserves data-quality gates and the requested horizon when data is unavailable', () => {
    const market = createMarket();
    market.ticker.time = NOW - 20_001;

    expect(getForecast({ ...market, horizonMinutes: 14.8 })).toMatchObject({
      available: false,
      reason: expect.stringMatching(/quote is stale/),
      aboveProbability: null,
      horizonMinutes: 14.8,
    });
    expect(getForecast({ ...createMarket({ count: 60 }), horizonMinutes: 1 })).toMatchObject({
      available: false,
      reason: expect.stringMatching(/61 completed/),
      sampleCount: 59,
      horizonMinutes: 1,
    });
  });

  test('uses zero drift even when historical returns have a positive mean', () => {
    const market = createMarket({ minuteReturns: [0.001, 0.002] });

    expect(getForecast(market).aboveProbability).toBe(0.5);
  });

  test('bounds the analyzed history to the last 120 completed candles', () => {
    const market = createMarket({ count: 180 });
    const recentForecast = getForecast({ ...market, candles: market.candles.slice(-120) });
    market.candles[0].close = NaN;
    market.candles[0].time -= MINUTE_IN_MILLISECONDS;

    expect(getForecast(market)).toEqual(recentForecast);
    expect(recentForecast.sampleCount).toBe(119);
  });

  test('does not use an in-progress or future candle', () => {
    const market = createMarket();
    const baseline = getForecast(market);
    const unfinishedCandle = { ...market.candles.at(-1), time: CURRENT_MINUTE, close: NaN };
    const futureCandle = {
      ...unfinishedCandle,
      time: CURRENT_MINUTE + MINUTE_IN_MILLISECONDS,
      close: 1_000_000,
    };

    expect(
      getForecast({ ...market, candles: [...market.candles, unfinishedCandle, futureCandle] }),
    ).toEqual(baseline);
  });

  test('requires 61 completed candles, without counting the current candle', () => {
    const market = createMarket({ count: 60 });
    const currentCandle = { ...market.candles.at(-1), time: CURRENT_MINUTE };
    const forecast = getForecast({ ...market, candles: [...market.candles, currentCandle] });

    expect(forecast.available).toBe(false);
    expect(forecast.sampleCount).toBe(59);
    expect(forecast.aboveProbability).toBeNull();
    expect(forecast.reason).toMatch(/61 completed/);
  });

  test.each([
    ['missing', (candles) => candles.splice(40, 1)],
    ['duplicate', (candles) => (candles[40].time = candles[39].time)],
    ['out-of-order', (candles) => ([candles[40], candles[41]] = [candles[41], candles[40]])],
  ])('rejects %s minutes in analyzed history', (_, changeCandles) => {
    const market = createMarket();
    changeCandles(market.candles);

    expect(getForecast(market)).toMatchObject({
      available: false,
      reason: expect.stringMatching(/missing, duplicate, or out-of-order/),
    });
  });

  test.each([NaN, Infinity, '123', null, -1, CURRENT_MINUTE + 1])(
    'rejects an invalid candle timestamp: %s',
    (time) => {
      const market = createMarket();
      market.candles[40].time = time;

      expect(getForecast(market).reason).toMatch(/invalid candle timestamp/);
    },
  );

  test.each([
    ['close', NaN],
    ['open', '50000'],
    ['high', 1],
    ['low', 1_000_000],
    ['close', 0],
    ['volume', -1],
    ['volume', Infinity],
  ])('rejects invalid candle %s values (%s)', (field, value) => {
    const market = createMarket();
    market.candles[40][field] = value;

    expect(getForecast(market).reason).toMatch(/invalid candle values/);
  });

  test('accepts candles and quotes with zero volume', () => {
    const market = createMarket();
    market.candles[40].volume = 0;
    market.ticker.volume = 0;

    expect(getForecast(market).available).toBe(true);
  });

  test('rejects history whose most recent candle closed more than two minutes ago', () => {
    const market = createMarket();
    market.candles.forEach((candle) => {
      candle.time -= 2 * MINUTE_IN_MILLISECONDS;
    });

    expect(getForecast(market).reason).toMatch(/history is stale/);
  });

  test.each(['time', 'receivedAt'])('requires the quote %s to be fresh', (field) => {
    const market = createMarket();
    market.ticker[field] = NOW - 20_001;

    expect(getForecast(market).reason).toMatch(/quote is stale/);
  });

  test.each(['time', 'receivedAt'])('rejects a future quote %s beyond clock tolerance', (field) => {
    const market = createMarket();
    market.ticker[field] = NOW + 5_001;

    expect(getForecast(market).reason).toMatch(/timestamp is invalid/);
  });

  test('accepts quote timestamps exactly at the freshness and clock-tolerance boundaries', () => {
    const market = createMarket();
    market.ticker.time = NOW - 20_000;
    market.ticker.receivedAt = NOW + 5_000;

    expect(getForecast(market).available).toBe(true);
  });

  test.each([
    ['price', NaN],
    ['price', 0],
    ['price', '50000'],
    ['bid', -1],
    ['ask', null],
    ['volume', -1],
  ])('rejects invalid quote %s values (%s)', (field, value) => {
    const market = createMarket();
    market.ticker[field] = value;

    expect(getForecast(market).reason).toMatch(/valid market quote/);
  });

  test('rejects a crossed quote', () => {
    const market = createMarket();
    market.ticker.bid = market.ticker.ask + 1;

    expect(getForecast(market).available).toBe(false);
  });

  test.each([NaN, Infinity, 0, -1, '50000', null, undefined, 1_000_000_001])(
    'rejects an invalid target without coercion: %s',
    (target) => {
      expect(getForecast({ ...createMarket(), target }).reason).toMatch(/Enter a target price/);
    },
  );

  test.each([NaN, Infinity, 0, '123'])('rejects an invalid current time: %s', (now) => {
    expect(getForecast({ ...createMarket(), now }).available).toBe(false);
  });

  test.each([[], null, undefined, {}])('returns unavailable for missing history: %s', (candles) => {
    expect(getForecast({ ...createMarket(), candles }).available).toBe(false);
  });

  test.each([
    ['zero', [0]],
    ['constant drift', [0.001]],
    ['negligible', [0.00000001, -0.00000001]],
    ['abnormally high', [0.06, -0.06]],
  ])('rejects %s volatility', (_, minuteReturns) => {
    expect(getForecast(createMarket({ minuteReturns })).reason).toMatch(/volatility/);
  });

  test('rejects an isolated extreme price jump', () => {
    const market = createMarket({ minuteReturns: [0.21, 0, 0, 0, 0, 0] });

    expect(getForecast(market).reason).toMatch(/price moves/);
  });

  test('does not mutate the supplied data', () => {
    const market = createMarket();
    const original = JSON.parse(JSON.stringify(market));

    getForecast(market);

    expect(market).toEqual(original);
  });
});

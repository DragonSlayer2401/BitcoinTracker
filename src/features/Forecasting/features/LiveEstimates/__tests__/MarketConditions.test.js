import { getForecast } from '../utils/forecast.utils';
import { getMarketConditions, MARKET_CONDITION_GUARDS } from '../utils/marketConditions.utils';

const MINUTE = 60_000;
const CURRENT_MINUTE = Date.UTC(2026, 8, 8, 12, 0);
const NOW = CURRENT_MINUTE + 15_000;

function makeMarket({
  count = 120,
  moves = [0.0001, -0.00012, 0.00009, -0.00007],
  wick = 0.00005,
} = {}) {
  let previousClose = 50_000;
  const candles = Array.from({ length: count }, (_, index) => {
    const close = previousClose * Math.exp(moves[index % moves.length]);
    const candle = {
      time: CURRENT_MINUTE - (count - index) * MINUTE,
      open: previousClose,
      high: Math.max(previousClose, close) * Math.exp(wick),
      low: Math.min(previousClose, close) * Math.exp(-wick),
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
      bid: previousClose - 0.1,
      ask: previousClose + 0.1,
      time: NOW - 1_000,
      receivedAt: NOW - 250,
      volume: 1000,
    },
    target: previousClose * 0.99,
    now: NOW,
    horizonMinutes: 15,
  };
}

const codes = (result) => result.riskFlags.map((flag) => flag.code);

describe('market condition features', () => {
  test('allows a quiet, fresh market and never changes its baseline probabilities', () => {
    const market = makeMarket();
    const forecast = getForecast(market);
    const original = { ...forecast };
    const result = getMarketConditions({ ...market, forecast });
    expect(result).toMatchObject({
      available: true,
      reason: null,
      canPublish: true,
      riskFlags: [],
    });
    expect(result.features.effectiveMinuteVolatility).toBeGreaterThan(0);
    expect(forecast).toEqual(original);
    expect(result.aboveProbability).toBeUndefined();
    expect(result.belowProbability).toBeUndefined();
  });

  test('uses completed closes for returns and acceleration at each requested interval', () => {
    const market = makeMarket();
    const { features } = getMarketConditions(market);
    [1, 3, 5, 15].forEach((minutes) => {
      const name = minutes === 1 ? 'logReturn1Minute' : `logReturn${minutes}Minutes`;
      expect(features[name]).toBeCloseTo(
        Math.log(market.candles.at(-1).close / market.candles.at(-1 - minutes).close),
        12,
      );
    });
    expect(features.logReturnAcceleration3Minutes).toBeCloseTo(
      features.logReturn3Minutes -
        Math.log(market.candles.at(-4).close / market.candles.at(-7).close),
      12,
    );
  });

  test('a wide wick changes range risk even when the latest close and close-return variance do not change', () => {
    const quiet = makeMarket();
    const longWick = { ...quiet, candles: quiet.candles.map((candle) => ({ ...candle })) };
    longWick.candles.at(-1).high *= 1.01;
    longWick.candles.at(-1).low *= 0.99;
    const quietResult = getMarketConditions(quiet);
    const wickResult = getMarketConditions(longWick);
    expect(wickResult.features.logReturn1Minute).toBe(quietResult.features.logReturn1Minute);
    expect(wickResult.features.closeReturnVariance5Minutes).toBe(
      quietResult.features.closeReturnVariance5Minutes,
    );
    expect(wickResult.features.rangeVolatility5Minutes).toBeGreaterThan(
      quietResult.features.rangeVolatility5Minutes * 10,
    );
    expect(codes(wickResult)).toContain('extreme-candle-range');
    expect(wickResult.canPublish).toBe(false);
    expect(wickResult.features.closePosition).toBeGreaterThan(0);
    expect(wickResult.features.closePosition).toBeLessThan(1);
  });

  test('compares recent volume with inclusive trailing baselines and keeps zero volume undefined rather than infinite', () => {
    const market = makeMarket();
    market.candles.slice(-5).forEach((candle) => {
      candle.volume = 50;
    });
    const { features } = getMarketConditions(market);
    expect(features.relativeVolume5To30Minutes).toBeCloseTo(50 / ((25 * 10 + 5 * 50) / 30));
    expect(features.relativeVolume5To120Minutes).toBeCloseTo(50 / ((115 * 10 + 5 * 50) / 120));
    market.candles.forEach((candle) => {
      candle.volume = 0;
    });
    const zeroVolume = getMarketConditions(market);
    expect(zeroVolume.available).toBe(true);
    expect(zeroVolume.features.relativeVolume5To30Minutes).toBeNull();
    expect(zeroVolume.features.relativeVolume5To120Minutes).toBeNull();
  });

  test('ignores an unfinished OHLCV snapshot completely', () => {
    const market = makeMarket();
    const baseline = getMarketConditions(market);
    const partial = {
      ...market.candles.at(-1),
      time: CURRENT_MINUTE,
      high: 1e10,
      low: 1,
      close: 1e9,
      volume: 1e9,
    };
    expect(getMarketConditions({ ...market, candles: [...market.candles, partial] })).toEqual(
      baseline,
    );
  });

  test('EWMA reacts more to recent movement than the same movement earlier in history', () => {
    const quietMoves = Array.from({ length: 120 }, (_, index) => (index % 2 ? 0.0001 : -0.0001));
    const earlyMoves = [...quietMoves];
    const recentMoves = [...quietMoves];
    earlyMoves[70] = 0.002;
    recentMoves[118] = 0.002;
    const early = getMarketConditions(makeMarket({ moves: earlyMoves }));
    const recent = getMarketConditions(makeMarket({ moves: recentMoves }));
    expect(recent.features.ewmaMinuteVolatility).toBeGreaterThan(
      early.features.ewmaMinuteVolatility * 2,
    );
    expect(recent.features.shortLongVarianceRatio).toBeCloseTo(
      recent.features.shortLongVolatilityRatio ** 2,
    );
    expect(codes(recent)).toContain('volatility-expansion');
  });

  test('uses all available completed data without pretending a 61-candle baseline contains 120 observations', () => {
    const result = getMarketConditions(makeMarket({ count: 61 }));
    expect(result.available).toBe(true);
    expect(result.features.completedCandleCount).toBe(61);
    expect(result.features.volumeBaseline120SampleCount).toBe(61);
  });
});

describe('publication risk guards', () => {
  test('detects an immediate trade jump before any new candle has closed', () => {
    const market = makeMarket();
    const price = market.ticker.price * 1.01;
    const result = getMarketConditions({
      ...market,
      ticker: { ...market.ticker, price, bid: price - 0.1, ask: price + 0.1 },
    });
    expect(result.available).toBe(true);
    expect(result.features.latestCompletedAt).toBe(CURRENT_MINUTE);
    expect(result.features.currentJumpElapsedMinutes).toBeCloseTo(14 / 60);
    expect(result.features.currentJumpStandardDeviations).toBeGreaterThan(4);
    expect(codes(result)).toContain('current-price-jump');
    expect(result.canPublish).toBe(false);
  });

  test('scales current jumps by elapsed minutes, with a one-second floor only for nonnegative intervals', () => {
    const market = makeMarket();
    const ticker = { ...market.ticker, time: CURRENT_MINUTE, price: market.ticker.price * 1.0001 };
    const result = getMarketConditions({ ...market, ticker });
    expect(result.features.currentJumpElapsedMinutes).toBe(1 / 60);
    expect(result.features.currentJumpStandardDeviations).toBeCloseTo(
      Math.abs(result.features.currentJumpLogReturn) /
        (result.features.effectiveMinuteVolatility * Math.sqrt(1 / 60)),
    );
    const delayed = getMarketConditions({
      ...market,
      ticker: { ...ticker, time: CURRENT_MINUTE - 1 },
    });
    expect(delayed.available).toBe(true);
    expect(delayed.features.currentJumpElapsedMinutes).toBeNull();
    expect(delayed.features.currentJumpStandardDeviations).toBeNull();
    expect(codes(delayed)).toContain('negative-jump-interval');
    expect(delayed.canPublish).toBe(false);
  });

  test('retains monotonic selloff magnitude despite tiny centered variance and abstains from the opposing side', () => {
    const market = makeMarket({ moves: [-0.00052, -0.00048], wick: 0.000001 });
    const result = getMarketConditions(market);
    expect(result.available).toBe(true);
    expect(result.features.momentumDirection5Minutes).toBe('down');
    expect(result.features.returnSignPersistence5Minutes).toBe(1);
    expect(result.features.effectiveMinuteVolatility).toBeGreaterThan(
      result.features.baselineMinuteVolatility * 10,
    );
    expect(codes(result)).toContain('adverse-momentum');
    expect(result.canPublish).toBe(false);
    const aligned = getMarketConditions({ ...market, target: market.ticker.price * 1.01 });
    expect(codes(aligned)).not.toContain('adverse-momentum');
  });

  test('a steady downward continuation is not mislabeled a many-sigma jump by centered-variance collapse', () => {
    const market = makeMarket({ moves: [-0.00052, -0.00048], wick: 0.000001 });
    const elapsed = (market.ticker.time - CURRENT_MINUTE) / MINUTE;
    const price = market.ticker.price * Math.exp(-0.0005 * elapsed);
    const result = getMarketConditions({
      ...market,
      ticker: { ...market.ticker, price, bid: price - 0.1, ask: price + 0.1 },
    });
    expect(result.features.currentJumpStandardDeviations).toBeLessThan(1);
    expect(codes(result)).not.toContain('current-price-jump');
    expect(codes(result)).toContain('adverse-momentum');
  });

  test.each(['bid', 'ask', 'price'])(
    'pauses when the target lies on or inside the quoted spread: %s',
    (field) => {
      const market = makeMarket();
      const result = getMarketConditions({ ...market, target: market.ticker[field] });
      expect(codes(result)).toContain('target-inside-spread');
      expect(result.canPublish).toBe(false);
    },
  );

  test('detects opposite target sides for the last trade and current midpoint outside the spread', () => {
    const market = makeMarket();
    const target = market.ticker.price - 1;
    const ticker = { ...market.ticker, bid: target - 1, ask: target - 0.5 };
    const result = getMarketConditions({ ...market, target, ticker });
    expect(codes(result)).toContain('quote-target-disagreement');
    expect(codes(result)).not.toContain('target-inside-spread');
    expect(result.features.spread).toBe(0.5);
    expect(result.features.midpoint).toBe(target - 0.75);
    expect(result.features.lastTradeMidpointLogDifference).toBeGreaterThan(0);
  });

  test('tightens quote freshness to six seconds for a one-minute horizon', () => {
    const market = makeMarket();
    const ticker = { ...market.ticker, time: NOW - 7_000 };
    expect(getMarketConditions({ ...market, ticker, horizonMinutes: 15 }).canPublish).toBe(true);
    const shortWindow = getMarketConditions({ ...market, ticker, horizonMinutes: 1 });
    expect(shortWindow.available).toBe(true);
    expect(shortWindow.features.maximumQuoteAgeMs).toBe(6_000);
    expect(codes(shortWindow)).toContain('quote-too-old');
    expect(shortWindow.canPublish).toBe(false);
    expect(
      getMarketConditions({
        ...market,
        ticker: { ...ticker, time: NOW - 6_000 },
        horizonMinutes: 1,
      }).canPublish,
    ).toBe(true);
  });

  test('applies the adaptive freshness check to receipt time too, and never treats a future quote as fresh', () => {
    const market = makeMarket();
    expect(
      codes(
        getMarketConditions({
          ...market,
          ticker: { ...market.ticker, receivedAt: NOW - 7_000 },
          horizonMinutes: 1,
        }),
      ),
    ).toContain('quote-too-old');
    expect(
      codes(getMarketConditions({ ...market, ticker: { ...market.ticker, time: NOW + 1_000 } })),
    ).toContain('quote-from-future');
  });
});

describe('defensive market availability', () => {
  test('inherits unavailable baseline data even if the market could otherwise produce features', () => {
    expect(
      getMarketConditions({
        ...makeMarket(),
        forecast: { available: false, reason: 'Market data paused.' },
      }),
    ).toEqual({
      available: false,
      reason: 'Market data paused.',
      features: null,
      riskFlags: [],
      canPublish: false,
    });
  });

  test.each([
    (market) => ({ ...market, candles: null }),
    (market) => ({ ...market, candles: [...market.candles].reverse() }),
    (market) => ({
      ...market,
      candles: market.candles.slice(1).filter((_, index) => index !== 50),
    }),
    (market) => ({ ...market, ticker: { ...market.ticker, bid: market.ticker.ask + 1 } }),
    (market) => ({ ...market, horizonMinutes: 0 }),
    (market) => ({ ...market, target: NaN }),
  ])('revalidates malformed inputs instead of trusting a stale available forecast', (change) => {
    const market = makeMarket();
    const result = getMarketConditions({ ...change(market), forecast: getForecast(market) });
    expect(result.available).toBe(false);
    expect(result.features).toBeNull();
    expect(result.canPublish).toBe(false);
  });

  test('returns unavailable for omitted data and arithmetic overflow without throwing', () => {
    expect(getMarketConditions().available).toBe(false);
    expect(getMarketConditions(null).available).toBe(false);
    expect(getMarketConditions([]).available).toBe(false);
    const market = makeMarket();
    market.candles.forEach((candle) => {
      candle.volume = 1e308;
    });
    expect(getMarketConditions(market)).toMatchObject({
      available: false,
      features: null,
      canPublish: false,
    });
  });

  test('pauses only after the elapsed-time price jump crosses its guard', () => {
    const market = makeMarket();
    const { features } = getMarketConditions(market);
    const threshold = MARKET_CONDITION_GUARDS.maximumJumpStandardDeviations;
    const moveScale =
      features.effectiveMinuteVolatility * Math.sqrt(features.currentJumpElapsedMinutes);
    const atDistance = (distance) => {
      const price = market.ticker.price * Math.exp(distance * moveScale);
      return getMarketConditions({
        ...market,
        ticker: { ...market.ticker, price, bid: price - 0.1, ask: price + 0.1 },
      });
    };
    expect(codes(atDistance(threshold * 0.99))).not.toContain('current-price-jump');
    expect(codes(atDistance(threshold * 1.01))).toContain('current-price-jump');
  });
});

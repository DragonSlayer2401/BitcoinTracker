import {
  DERIVATIVES_FORECAST_VERSION,
  DERIVATIVES_MODEL_PARAMETERS,
  getDerivativesForecast,
  getDerivativesLogShift,
  getDerivativesVarianceTime,
  isDerivativesForecastMetadata,
} from '../utils/derivativesForecast.utils';
import {
  getKalshiForecast,
  KALSHI_MODEL_VERSION,
  KALSHI_DERIVATIVES_MODEL_VERSION,
} from '../utils/kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const MINUTE = 60_000;
const END = Date.UTC(2026, 8, 13, 12, 15);
const NOW = END - 5 * MINUTE;
const SIGMA = 0.001;

function snapshot(direction = 1, now = NOW) {
  return {
    version: 'bybit-linear-flow-v1',
    source: 'bybit-linear',
    symbol: 'BTCUSDT',
    status: 'live',
    asOf: now,
    quality: {
      subscribed: true,
      completeSince: now - 240_000,
      lastMessageAt: now,
      lastTradeAt: now,
    },
    windows: Object.fromEntries(
      [15, 60, 180].map((seconds) => {
        const buyBtc = ((direction > 0 ? 3 : 1) * seconds) / 15;
        const sellBtc = ((direction > 0 ? 1 : 3) * seconds) / 15;
        return [
          seconds,
          {
            available: true,
            buyBtc,
            sellBtc,
            totalBtc: buyBtc + sellBtc,
            signedBtc: buyBtc - sellBtc,
            imbalance: (buyBtc - sellBtc) / (buyBtc + sellBtc),
            tradeCount: (20 * seconds) / 15,
            logReturn: (direction * 0.00025 * seconds) / 15,
            largeTradesAvailable: false,
            largeBuyBtc: null,
            largeSellBtc: null,
            largeTradeCount: null,
          },
        ];
      }),
    ),
    impact: {
      available: true,
      asOf: now,
      completeSince: now - 240_000,
      bucketSeconds: 15,
      samples: Array.from({ length: 12 }, (_, index) => {
        const signed = index % 2 ? 2 : -2;
        return {
          startAt: now - (12 - index) * 15_000,
          endAt: now - (11 - index) * 15_000,
          startPrice: 50_000,
          endPrice: 50_000 * Math.exp(signed * 0.0001),
          buyBtc: signed > 0 ? 3 : 1,
          sellBtc: signed > 0 ? 1 : 3,
          tradeCount: 20,
        };
      }),
    },
    liquidations: {
      available: true,
      windows: Object.fromEntries(
        [15, 60, 180].map((seconds) => [
          seconds,
          { available: true, longBtc: 0, shortBtc: 0, count: 0 },
        ]),
      ),
    },
    ticker: { time: now, markPrice: 50_010, indexPrice: 50_000, openInterest: 100_000 },
  };
}

function forecastInput(now = NOW) {
  return {
    now,
    ticker: null,
    candles: [],
    kalshiMarket: {
      ticker: 'KXBTC15M-26SEP131215-15',
      eventTicker: 'KXBTC15M-26SEP131215',
      seriesTicker: 'KXBTC15M',
      startsAt: END - 15 * MINUTE,
      expiresAt: END,
      target: 50_000,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    },
    benchmark: {
      status: 'live',
      current: { time: now, price: 50_000 },
      samples: [],
      receivedAt: now,
    },
  };
}

function pressureBase(signedBtcPerMinute = 0) {
  return {
    available: true,
    sampleCount: 119,
    pressure: {
      applied: signedBtcPerMinute !== 0,
      impactCoefficient: 0.0001,
      components: { minuteVolatility: SIGMA, signedBtcPerMinute },
    },
  };
}

const calculate = (value, now = NOW) =>
  getDerivativesForecast({
    snapshot: value,
    now,
    minuteVolatility: SIGMA,
    horizonMinutes: (END - now) / MINUTE,
  });

describe('Futures context in the current settlement calculation', () => {
  test('buying and selling with matching price response produce symmetric bounded shifts', () => {
    const buy = calculate(snapshot(1));
    const sell = calculate(snapshot(-1));
    expect(buy).toMatchObject({
      available: true,
      applied: true,
      version: DERIVATIVES_FORECAST_VERSION,
      impactSampleCount: 12,
      priceResponse: 1,
    });
    expect(buy.expectedLogReturn).toBeGreaterThan(0);
    expect(sell.expectedLogReturn).toBeCloseTo(-buy.expectedLogReturn, 14);
    expect(buy.reliability).toBeCloseTo(0.5);
    expect(buy.basisLogReturn).toBeCloseTo(Math.log(50_010 / 50_000));
    expect(isDerivativesForecastMetadata(buy)).toBe(true);
  });

  test('absorbed heavy selling does not automatically push the predicted ending price down', () => {
    const falling = snapshot(-1);
    const absorbed = snapshot(-1);
    for (const window of Object.values(absorbed.windows)) window.logReturn = 0;
    expect(calculate(falling).expectedLogReturn).toBeLessThan(0);
    expect(calculate(absorbed)).toMatchObject({
      available: true,
      applied: false,
      priceResponse: 0,
      expectedLogReturn: 0,
    });
    for (const window of Object.values(absorbed.windows)) window.logReturn = 0.001;
    expect(calculate(absorbed).expectedLogReturn).toBe(0);
  });

  test('a weak price response and weak historical impact both shrink the correction', () => {
    const weakResponse = snapshot();
    for (const window of Object.values(weakResponse.windows)) window.logReturn *= 0.1;
    const weakFit = snapshot();
    for (const sample of weakFit.impact.samples) sample.endPrice = sample.startPrice;
    expect(calculate(weakResponse).expectedLogReturn).toBeGreaterThan(0);
    expect(calculate(weakResponse).expectedLogReturn).toBeLessThan(
      calculate(snapshot()).expectedLogReturn,
    );
    expect(calculate(weakFit)).toMatchObject({
      applied: false,
      reliability: 0,
      impactCoefficient: 0,
    });
  });

  test('large execution direction reweights existing volume without adding another volume tally', () => {
    const buying = snapshot();
    const selling = snapshot();
    for (const [secondsText, window] of Object.entries(buying.windows))
      Object.assign(window, {
        largeTradesAvailable: true,
        largeBuyBtc: Number(secondsText) / 15,
        largeSellBtc: 0,
        largeTradeCount: 1,
      });
    for (const [secondsText, window] of Object.entries(selling.windows))
      Object.assign(window, {
        largeTradesAvailable: true,
        largeBuyBtc: 0,
        largeSellBtc: Number(secondsText) / 15,
        largeTradeCount: 1,
      });
    expect(calculate(buying).largeTradeImbalance).toBe(1);
    expect(calculate(selling).largeTradeImbalance).toBe(-1);
    expect(calculate(buying).expectedLogReturn).toBeGreaterThan(
      calculate(snapshot()).expectedLogReturn,
    );
    expect(calculate(selling).expectedLogReturn).toBeLessThan(
      calculate(snapshot()).expectedLogReturn,
    );
    expect(calculate(buying).signedBtcPerMinute).toBeLessThan(16);
    expect(buying.windows[60].totalBtc).toBe(selling.windows[60].totalBtc);
  });

  test('long liquidations are sell context and short liquidations buy context, with bounded added uncertainty', () => {
    const long = snapshot(-1);
    const short = snapshot(1);
    long.liquidations.windows[180] = { available: true, longBtc: 6, shortBtc: 0, count: 4 };
    short.liquidations.windows[180] = { available: true, longBtc: 0, shortBtc: 6, count: 4 };
    const sell = calculate(long);
    const buy = calculate(short);
    expect(sell).toMatchObject({
      liquidationImbalance: -1,
      relativeLiquidationVolume: 0.125,
      liquidationStress: 0.5,
      futureVarianceMultiplier: 1.25,
    });
    expect(buy.liquidationImbalance).toBe(1);
    expect(sell.expectedLogReturn).toBeCloseTo(-buy.expectedLogReturn, 14);
    expect(sell.expectedLogReturn).toBeLessThan(calculate(snapshot(-1)).expectedLogReturn);
    expect(long.windows[180].totalBtc).toBe(48);
  });

  test('a liquidation burst still widens future risk when buyers absorb selling', () => {
    const absorbed = snapshot(-1);
    for (const window of Object.values(absorbed.windows)) window.logReturn = 0;
    absorbed.liquidations.windows[180] = { available: true, longBtc: 12, shortBtc: 0, count: 4 };
    expect(calculate(absorbed)).toMatchObject({
      applied: true,
      expectedLogReturn: 0,
      priceResponse: 0,
      futureVarianceMultiplier: 1.5,
    });
  });

  test.each(['missing', 'stale', 'disconnected', 'future'])(
    '%s optional futures data preserves the exact spot calculation',
    (kind) => {
      const value = snapshot();
      if (kind === 'stale') value.quality.lastTradeAt = NOW - 5001;
      if (kind === 'disconnected') value.status = 'reconnecting';
      if (kind === 'future') value.asOf = NOW + 1;
      const input = forecastInput();
      const base = pressureBase(500);
      const old = getKalshiForecast(input, base);
      const current = getKalshiForecast(
        { ...input, derivatives: kind === 'missing' ? null : value },
        base,
      );
      expect(old.modelVersion).toBe(KALSHI_MODEL_VERSION);
      expect(current).toMatchObject({
        available: true,
        modelVersion: KALSHI_DERIVATIVES_MODEL_VERSION,
        derivatives: {
          available: false,
          applied: false,
          expectedLogReturn: 0,
          adjustmentPercentagePoints: 0,
        },
      });
      expect(current.aboveProbability).toBe(old.aboveProbability);
      expect(current.kalshi).toEqual(old.kalshi);
      expect(current.pressure).toEqual(old.pressure);
      expect(isDerivativesForecastMetadata(current.derivatives)).toBe(true);
    },
  );

  test('undefined remains the legacy version while explicit null selects the new fallback policy', () => {
    expect(
      getKalshiForecast({ ...forecastInput(), derivatives: undefined }, pressureBase())
        .modelVersion,
    ).toBe(KALSHI_MODEL_VERSION);
    expect(
      getKalshiForecast({ ...forecastInput(), derivatives: null }, pressureBase()).modelVersion,
    ).toBe(KALSHI_DERIVATIVES_MODEL_VERSION);
  });

  test('warmup never blocks a settlement call and incomplete optional long windows are ignored', () => {
    const value = snapshot();
    value.impact.samples = value.impact.samples.slice(-4);
    const forecast = getKalshiForecast({ ...forecastInput(), derivatives: value }, pressureBase());
    expect(forecast).toMatchObject({
      available: true,
      derivatives: { available: true, applied: false },
    });
    const shorter = snapshot();
    shorter.windows[180] = { available: false };
    shorter.impact.samples = shorter.impact.samples.slice(-6);
    expect(calculate(shorter)).toMatchObject({
      available: true,
      applied: true,
      impactSampleCount: 6,
      imbalance180: null,
    });
  });

  test('valid volume remains usable when one window lacks a nearby price boundary', () => {
    const value = snapshot();
    value.windows[15].logReturn = null;
    value.windows[15].priceResponseAvailable = false;
    expect(calculate(value)).toMatchObject({ available: true, applied: true, imbalance15: 0.5 });
    for (const window of Object.values(value.windows)) {
      window.logReturn = null;
      window.priceResponseAvailable = false;
    }
    expect(calculate(value)).toMatchObject({
      available: true,
      applied: false,
      priceResponse: null,
      expectedLogReturn: 0,
      imbalance60: 0.5,
    });
    expect(isDerivativesForecastMetadata(calculate(value))).toBe(true);
  });

  test('individually valid nonoverlapping impact intervals can have missing intervals between them', () => {
    const value = snapshot();
    value.impact.samples = value.impact.samples.filter((_, index) => index !== 3 && index !== 7);
    expect(calculate(value)).toMatchObject({
      available: true,
      applied: true,
      impactSampleCount: 10,
    });
  });

  test('futures changes current probabilities while Coinbase is unavailable and BRTI remains the outcome', () => {
    const input = forecastInput();
    const start = NOW - 61 * MINUTE;
    const samples = Array.from({ length: (NOW - start) / 1000 + 1 }, (_, index) => {
      const time = start + index * 1000;
      return {
        time,
        price: 50_000 * Math.exp(0.0005 * Math.sin(((time - NOW) / MINUTE) * Math.PI)),
      };
    });
    input.benchmark = { status: 'live', samples, current: samples.at(-1), receivedAt: NOW };
    const price = getKalshiForecast({ ...input, derivatives: null });
    const buying = getKalshiForecast({ ...input, derivatives: snapshot() });
    const selling = getKalshiForecast({ ...input, derivatives: snapshot(-1) });
    expect(buying).toMatchObject({
      available: true,
      pressure: { applied: false },
      derivatives: { applied: true },
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      target: 50_000,
      kalshi: { referenceSource: 'cf-brti', volatilitySource: 'cf-brti', referencePrice: 50_000 },
    });
    expect(buying.aboveProbability).toBeGreaterThan(price.aboveProbability);
    expect(selling.aboveProbability).toBeLessThan(price.aboveProbability);
    expect(buying.derivatives.baselineAboveProbability).toBe(price.aboveProbability);
    expect(buying.derivatives.aboveProbability).toBe(buying.aboveProbability);
    expect(isDerivativesForecastMetadata(buying.derivatives)).toBe(true);
  });

  test('the 59 already observed BRTI slots remain fixed and only the final slot receives the shift', () => {
    const now = END - 1000;
    const input = forecastInput(now);
    input.benchmark.samples = Array.from({ length: 59 }, (_, index) => ({
      time: END - (59 - index) * 1000,
      price: 50_000,
    }));
    const value = snapshot(1, now);
    // Complete price-response buckets use exchange-aligned boundaries, not a fabricated clock.
    const difference = now % 15_000;
    for (const sample of value.impact.samples) {
      sample.startAt -= difference;
      sample.endAt -= difference;
    }
    const plain = getKalshiForecast({ ...input, derivatives: null }, pressureBase());
    const changed = getKalshiForecast({ ...input, derivatives: value }, pressureBase());
    expect(changed.kalshi).toMatchObject({
      observedSampleCount: 59,
      futureSampleCount: 1,
      requiredFutureAverage: plain.kalshi.requiredFutureAverage,
    });
    const lastFutureExpectedPrice = 50_000 * Math.exp(SIGMA ** 2 / 120);
    const expectedAverageChange =
      (lastFutureExpectedPrice * Math.expm1(changed.derivatives.expectedLogReturn)) / 60;
    expect(
      changed.kalshi.expectedSettlementAverage - plain.kalshi.expectedSettlementAverage,
    ).toBeCloseTo(expectedAverageChange, 8);
  });

  test('liquidation risk is added only to future covariance, not uncertain elapsed slots', () => {
    const now = END - 1000;
    const input = forecastInput(now);
    const value = snapshot(-1, now);
    for (const sample of value.impact.samples) {
      sample.startAt -= now % 15_000;
      sample.endAt -= now % 15_000;
    }
    for (const window of Object.values(value.windows)) window.logReturn = 0;
    value.liquidations.windows[180] = { available: true, longBtc: 12, shortBtc: 0, count: 4 };
    const quiet = getKalshiForecast({ ...input, derivatives: null }, pressureBase());
    const stress = getKalshiForecast({ ...input, derivatives: value }, pressureBase());
    expect(stress.kalshi.missingElapsedSampleCount).toBe(58);
    // Fifty-eight historical slots dominate variance. A single future slot cannot inflate it 50%.
    expect(stress.kalshi.settlementStandardDeviation).toBeGreaterThan(
      quiet.kalshi.settlementStandardDeviation,
    );
    expect(
      stress.kalshi.settlementStandardDeviation / quiet.kalshi.settlementStandardDeviation,
    ).toBeLessThan(1.001);
  });

  test('the futures policy preserves Kalshi cent rounding and YES equality at settlement', () => {
    const now = END - 1;
    const input = forecastInput(now);
    input.benchmark.samples = Array.from({ length: 59 }, (_, index) => ({
      time: END - (59 - index) * 1000,
      price: 50_000,
    }));
    const value = snapshot(1, now);
    for (const sample of value.impact.samples) {
      sample.startAt -= now % 15_000;
      sample.endAt -= now % 15_000;
    }
    const atTarget = getKalshiForecast({ ...input, derivatives: value }, pressureBase());
    const nextCent = getKalshiForecast(
      { ...input, derivatives: value, kalshiMarket: { ...input.kalshiMarket, target: 50_000.01 } },
      pressureBase(),
    );
    expect(atTarget.derivatives.applied).toBe(true);
    expect(atTarget.aboveProbability).toBeGreaterThan(0.8);
    expect(nextCent.aboveProbability).toBeLessThan(0.2);
    expect(atTarget.outcomeDefinition).toBe(KALSHI_OUTCOME_DEFINITION);
  });

  test('combined spot and futures pressure stays within one explicit directional budget', () => {
    const value = snapshot();
    for (const window of Object.values(value.windows)) {
      window.buyBtc *= 1e6;
      window.sellBtc *= 1e6;
      window.totalBtc *= 1e6;
      window.signedBtc *= 1e6;
    }
    const input = forecastInput();
    const plain = getKalshiForecast({ ...input, derivatives: null }, pressureBase());
    const changed = getKalshiForecast({ ...input, derivatives: value }, pressureBase(1e6));
    expect(changed.available).toBe(true);
    const limit =
      SIGMA * DERIVATIVES_MODEL_PARAMETERS.maximumCombinedMinuteVolatilities * Math.sqrt(3);
    expect(
      Math.log(changed.kalshi.expectedSettlementAverage / plain.kalshi.expectedSettlementAverage),
    ).toBeLessThanOrEqual(limit + 1e-12);
    expect(Math.abs(changed.derivatives.expectedLogReturn)).toBeLessThanOrEqual(
      SIGMA * 0.35 * Math.sqrt(3),
    );
    expect(changed.aboveProbability + changed.belowProbability).toBe(1);
  });

  test.each([
    'NaN',
    'overflow',
    'conflicting totals',
    'overlapping buckets',
    'future bucket',
    'invented large volume',
  ])('invalid %s does not contaminate the baseline', (kind) => {
    const value = snapshot();
    if (kind === 'NaN') value.windows[15].buyBtc = NaN;
    if (kind === 'overflow') value.impact.samples[0].buyBtc = Number.MAX_VALUE;
    if (kind === 'conflicting totals') value.windows[60].totalBtc += 1;
    if (kind === 'overlapping buckets') value.impact.samples[1] = { ...value.impact.samples[0] };
    if (kind === 'future bucket') value.impact.samples.at(-1).endAt = NOW + 15_000;
    if (kind === 'invented large volume')
      Object.assign(value.windows[15], {
        largeTradesAvailable: true,
        largeBuyBtc: 100,
        largeSellBtc: 0,
        largeTradeCount: 1,
      });
    const plain = getKalshiForecast({ ...forecastInput(), derivatives: null }, pressureBase());
    const changed = getKalshiForecast({ ...forecastInput(), derivatives: value }, pressureBase());
    expect(changed.available).toBe(true);
    expect(changed.derivatives.applied).toBe(false);
    expect(changed.aboveProbability).toBe(plain.aboveProbability);
    expect(isDerivativesForecastMetadata(changed.derivatives)).toBe(true);
  });

  test('decay starts at zero, saturates, and cannot move elapsed timestamps', () => {
    const value = calculate(snapshot());
    expect(getDerivativesLogShift(value, 0, SIGMA)).toBe(0);
    expect(getDerivativesLogShift(value, -1, SIGMA)).toBe(0);
    expect(getDerivativesLogShift(value, 15, SIGMA)).toBeLessThan(
      getDerivativesLogShift(value, 1, SIGMA) * 3,
    );
    expect(getDerivativesVarianceTime(-1)).toBe(0);
    expect(getDerivativesVarianceTime(0)).toBe(0);
    expect(getDerivativesVarianceTime(15)).toBeLessThan(1);
  });

  test('restoration rejects malformed diagnostics and unexplained probability changes', () => {
    const value = getKalshiForecast(
      { ...forecastInput(), derivatives: snapshot() },
      pressureBase(),
    ).derivatives;
    expect(isDerivativesForecastMetadata(value)).toBe(true);
    for (const patch of [
      { imbalance15: 2 },
      { expectedLogReturn: NaN },
      { asOf: -1 },
      { adjustmentPercentagePoints: 99 },
      { futureVarianceMultiplier: 2 },
      { applied: false },
    ]) {
      expect(isDerivativesForecastMetadata({ ...value, ...patch })).toBe(false);
    }
  });
});

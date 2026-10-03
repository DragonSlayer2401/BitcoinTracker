import { getKalshiForecast } from '../utils/kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { PRESSURE_MODEL_PARAMETERS } from '../utils/pressureForecast.utils';
import {
  getResearchVariantNames,
  PRESSURE_RESEARCH_POLICIES,
  RESEARCH_EXPERIMENT_V1,
  RESEARCH_EXPERIMENT_V2,
} from '../utils/researchVariantConfig.utils';

const END = Date.UTC(2026, 8, 15, 12, 15);
const NOW = END - 5 * 60_000;
const PRICE = 50_000;

function getInput(now = NOW) {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: now - (1200 - index) * 1000,
    price: PRICE,
  }));
  return {
    now,
    kalshiMarket: {
      ticker: 'KXBTC15M-26SEP151215-15',
      eventTicker: 'KXBTC15M-26SEP151215',
      seriesTicker: 'KXBTC15M',
      startsAt: END - 900_000,
      expiresAt: END,
      target: PRICE,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    },
    benchmark: { samples, current: samples.at(-1), receivedAt: now },
    derivatives: null,
  };
}

function getBase(coefficient = 0.000001) {
  return {
    available: true,
    pressure: {
      applied: true,
      reason: null,
      impactCoefficient: coefficient,
      parameters: PRESSURE_MODEL_PARAMETERS,
      components: { signedBtcPerMinute: 1, minuteVolatility: 0.00001 },
    },
  };
}

function getFutures({ flowMultiplier = 1, priceResponse = true, liquidations = false } = {}) {
  return {
    version: 'bybit-linear-flow-v1',
    source: 'bybit-linear',
    symbol: 'BTCUSDT',
    status: 'live',
    asOf: NOW,
    quality: {
      subscribed: true,
      completeSince: NOW - 240_000,
      lastTradeAt: NOW,
      lastMessageAt: NOW,
    },
    windows: Object.fromEntries(
      [15, 60, 180].map((seconds) => [
        seconds,
        {
          available: true,
          buyBtc: ((3 * seconds) / 15) * flowMultiplier,
          sellBtc: (seconds / 15) * flowMultiplier,
          totalBtc: ((4 * seconds) / 15) * flowMultiplier,
          signedBtc: ((2 * seconds) / 15) * flowMultiplier,
          imbalance: 0.5,
          tradeCount: (20 * seconds) / 15,
          logReturn: priceResponse ? 0.001 : 0,
          priceResponseAvailable: true,
          largeTradesAvailable: false,
        },
      ]),
    ),
    impact: {
      available: true,
      asOf: NOW,
      completeSince: NOW - 240_000,
      bucketSeconds: 15,
      samples: Array.from({ length: 12 }, (_, index) => ({
        startAt: NOW - (12 - index) * 15_000,
        endAt: NOW - (11 - index) * 15_000,
        startPrice: PRICE,
        endPrice: PRICE * Math.exp(0.0002),
        buyBtc: 3,
        sellBtc: 1,
        tradeCount: 20,
      })),
    },
    liquidations: {
      available: liquidations,
      windows: Object.fromEntries(
        [15, 60, 180].map((seconds) => [
          seconds,
          {
            available: liquidations,
            longBtc: 0,
            shortBtc: seconds / 15,
            count: seconds / 15,
          },
        ]),
      ),
    },
  };
}

const getVariants = (input, base) =>
  getKalshiForecast(input, base, {
    includeResearchVariants: true,
    researchVersion: RESEARCH_EXPERIMENT_V2,
  });

test('research v2 leaves production and all four original variants exactly unchanged', () => {
  const input = getInput();
  const base = getBase();
  const original = JSON.stringify({ input, base });
  const production = getKalshiForecast(input, base, { researchVersion: RESEARCH_EXPERIMENT_V1 });
  const legacy = getKalshiForecast(input, base, {
    includeResearchVariants: true,
    researchVersion: RESEARCH_EXPERIMENT_V1,
  });
  const explicitLegacy = getKalshiForecast(input, base, {
    includeResearchVariants: true,
    researchVersion: RESEARCH_EXPERIMENT_V1,
  });
  const { researchVariants, ...current } = getVariants(input, base);
  expect(current).toEqual(production);
  expect(explicitLegacy).toEqual(legacy);
  for (const name of getResearchVariantNames(RESEARCH_EXPERIMENT_V1)) {
    expect(researchVariants[name]).toEqual(legacy.researchVariants[name]);
  }
  expect(JSON.stringify({ input, base })).toBe(original);
  expect(researchVariants['reduced-pressure'].policyVersion).toBe(
    PRESSURE_RESEARCH_POLICIES['reduced-pressure'].version,
  );
  expect(researchVariants['fast-decay'].policyVersion).toBe(
    PRESSURE_RESEARCH_POLICIES['fast-decay'].version,
  );
});

test('reduced and faster pressure shrink an uncapped directional effect without blocking a call', () => {
  const result = getVariants(getInput(), getBase());
  const variants = result.researchVariants;
  for (const name of ['reduced-pressure', 'fast-decay']) {
    expect(variants[name].available).toBe(true);
    expect(variants[name].aboveProbability).toBeGreaterThan(
      variants['settlement-only'].aboveProbability,
    );
    expect(variants[name].aboveProbability).toBeLessThan(variants.combined.aboveProbability);
    expect(variants[name].referencePrice).toBe(result.kalshi.referencePrice);
    expect(variants[name].minuteVolatility).toBe(result.kalshi.minuteVolatility);
    expect(variants[name].basisLogDeviation).toBe(result.kalshi.basisLogDeviation);
  }
});

test('faster decay applies before the pressure cap rather than scaling an already capped shift', () => {
  const variants = getVariants(getInput(), getBase(1)).researchVariants;
  // Both decay curves remain above the same cap for this deliberately extreme input.
  expect(variants['fast-decay'].expectedSettlementAverage).toBe(
    variants.combined.expectedSettlementAverage,
  );
  expect(variants['reduced-pressure'].expectedSettlementAverage).toBeLessThan(
    variants.combined.expectedSettlementAverage,
  );
});

test('missing or zero pressure leaves the available settlement estimate unchanged', () => {
  for (const base of [getBase(0), { available: false, pressure: { applied: false } }]) {
    const result = getVariants(getInput(), base);
    expect(result.available).toBe(true);
    for (const variant of Object.values(result.researchVariants)) {
      expect(variant.available).toBe(true);
      expect(variant.aboveProbability).toBe(result.aboveProbability);
      expect(variant.expectedSettlementAverage).toBe(result.kalshi.expectedSettlementAverage);
    }
  }
});

test('directional pressure experiments preserve the existing liquidation variance when drift is zero', () => {
  const input = getInput();
  input.derivatives = getFutures({ priceResponse: false, liquidations: true });
  const result = getVariants(input, getBase(0));
  const variants = result.researchVariants;
  expect(result.derivatives.applied).toBe(true);
  expect(result.derivatives.expectedLogReturn).toBe(0);
  expect(variants.combined.settlementStandardDeviation).toBeGreaterThan(
    variants['settlement-only'].settlementStandardDeviation,
  );
  for (const name of ['reduced-pressure', 'fast-decay']) {
    expect(variants[name].aboveProbability).toBe(variants.combined.aboveProbability);
    expect(variants[name].expectedSettlementAverage).toBe(
      variants.combined.expectedSettlementAverage,
    );
    expect(variants[name].settlementStandardDeviation).toBe(
      variants.combined.settlementStandardDeviation,
    );
  }
});

test('futures faster decay is also calculated before capping, and combined production stays untouched', () => {
  const input = getInput();
  input.derivatives = getFutures({ flowMultiplier: 100 });
  const base = getBase(0);
  const original = getKalshiForecast(input, base, { researchVersion: RESEARCH_EXPERIMENT_V1 });
  const { researchVariants, ...current } = getVariants(input, base);
  expect(original.derivatives.applied).toBe(true);
  expect(current).toEqual(original);
  expect(researchVariants['fast-decay'].expectedSettlementAverage).toBe(
    researchVariants.combined.expectedSettlementAverage,
  );
  expect(researchVariants['reduced-pressure'].expectedSettlementAverage).toBeLessThan(
    researchVariants.combined.expectedSettlementAverage,
  );
});

test('faster pressure changes only future settlement readings, retaining missing elapsed uncertainty', () => {
  const now = END - 20_000;
  const input = getInput(now);
  input.benchmark.samples = input.benchmark.samples.filter((sample) => sample.time !== now - 5000);
  const base = getBase();
  const result = getVariants(input, base);
  const variance = result.kalshi.minuteVolatility ** 2;
  let expectedSum = 39 * PRICE;
  // The missing elapsed reading is halfway between two genuine readings two seconds apart.
  expectedSum += PRICE * Math.exp(variance / 120 / 2);
  for (let seconds = 1; seconds <= 20; seconds++) {
    const minutes = seconds / 60;
    const decayRate = Math.log(2) / 0.5;
    const shift = (base.pressure.impactCoefficient * -Math.expm1(-decayRate * minutes)) / decayRate;
    expectedSum += PRICE * Math.exp(shift + (variance * minutes) / 2);
  }
  expect(result.kalshi.observedSampleCount).toBe(39);
  expect(result.kalshi.missingElapsedSampleCount).toBe(1);
  expect(result.researchVariants['fast-decay'].expectedSettlementAverage).toBeCloseTo(
    expectedSum / 60,
    8,
  );
});

test('unknown experiment versions never silently select current policies', () => {
  expect(getResearchVariantNames('future-unknown')).toEqual([]);
  expect(getResearchVariantNames(RESEARCH_EXPERIMENT_V2)).toContain('reversal-candidate');
});

import { getMarketResearchVariants } from '../utils/marketBlendForecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { MARKET_BLEND_POLICY } from '../utils/researchVariantConfig.utils';

const END = Date.UTC(2026, 8, 15, 12, 15);
const NOW = END - 300_000;

function fixture(now = NOW) {
  const market = {
    ticker: 'KXBTC15M-26SEP151215-15',
    eventTicker: 'KXBTC15M-26SEP151215',
    seriesTicker: 'KXBTC15M',
    startsAt: END - 900_000,
    expiresAt: END,
    target: 50_000,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const forecast = {
    available: true,
    target: market.target,
    expiresAt: market.expiresAt,
    modelVersion: 'kalshi-brti-derivatives-v1',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    aboveProbability: 0.6,
    belowProbability: 0.4,
    pressure: { applied: true },
    derivatives: { applied: false },
    kalshi: {
      marketTicker: market.ticker,
      referenceSource: 'cf-brti',
      referencePrice: 50_010,
      referenceAt: now,
      minuteVolatility: 0.0005,
      basisLogDeviation: 0,
    },
  };
  const quote = {
    marketTicker: market.ticker,
    target: market.target,
    expiresAt: END,
    receivedAt: now - 1000,
    yesBid: 0.7,
    yesAsk: 0.74,
  };
  return { forecast, input: { market, quote, now } };
}

test('bounded market blend uses the matching midpoint and preserves settlement/reference identity', () => {
  const { forecast, input } = fixture();
  const original = JSON.stringify({ forecast, input });
  const variants = getMarketResearchVariants(forecast, input);
  const blend = variants['market-blend'];
  expect(blend).toMatchObject({
    available: true,
    appliedMarket: true,
    appliedSpot: true,
    marketProbability: 0.72,
    marketQuoteAgeMs: 1000,
    referenceSource: forecast.kalshi.referenceSource,
    referencePrice: forecast.kalshi.referencePrice,
    referenceAt: forecast.kalshi.referenceAt,
    policyVersion: MARKET_BLEND_POLICY.version,
    settlementLowerBound: null,
    settlementUpperBound: null,
    settlementStandardDeviation: null,
  });
  expect(blend.marketWeight).toBeCloseTo(0.3833333333333333);
  expect(blend.aboveProbability).toBeCloseTo(0.646);
  expect(blend.belowProbability).toBe(1 - blend.aboveProbability);
  expect(variants['market-only']).toMatchObject({
    aboveProbability: 0.72,
    marketWeight: 1,
    appliedSpot: false,
    appliedFutures: false,
  });
  expect(JSON.stringify({ forecast, input })).toBe(original);
});

test('market weight rises as the deadline approaches while remaining capped', () => {
  const weights = [END - 900_000, END - 60_000, END - 1].map((now) => {
    const { forecast, input } = fixture(now);
    return getMarketResearchVariants(forecast, input)['market-blend'].marketWeight;
  });
  expect(weights[0]).toBe(MARKET_BLEND_POLICY.minimumMarketWeight);
  expect(weights[1]).toBeGreaterThan(weights[0]);
  expect(weights[2]).toBeGreaterThan(weights[1]);
  expect(weights[2]).toBeLessThanOrEqual(MARKET_BLEND_POLICY.maximumMarketWeight);
});

test.each([
  [
    'missing',
    (input) => {
      input.quote = null;
    },
  ],
  [
    'old',
    (input) => {
      input.quote.receivedAt = NOW - 15_001;
    },
  ],
  [
    'future',
    (input) => {
      input.quote.receivedAt = NOW + 1;
    },
  ],
  [
    'wrong market',
    (input) => {
      input.quote.marketTicker += '-OTHER';
    },
  ],
  [
    'wrong target',
    (input) => {
      input.quote.target++;
    },
  ],
  [
    'wrong expiry',
    (input) => {
      input.quote.expiresAt++;
    },
  ],
  [
    'crossed',
    (input) => {
      input.quote.yesBid = 0.8;
    },
  ],
  [
    'wide',
    (input) => {
      input.quote.yesAsk = 0.81;
    },
  ],
])('%s quote falls back without vetoing a valid base forecast', (_, change) => {
  const { forecast, input } = fixture();
  change(input);
  const variants = getMarketResearchVariants(forecast, input);
  expect(variants['market-blend']).toMatchObject({
    available: true,
    aboveProbability: forecast.aboveProbability,
    belowProbability: forecast.belowProbability,
    appliedMarket: false,
    marketWeight: 0,
  });
  expect(variants['market-blend'].fallbacks.length).toBeGreaterThan(0);
  expect(variants['market-blend'].marketReason).toBeTruthy();
  expect(variants['market-only']).toMatchObject({ available: false, aboveProbability: null });
});

test.each([
  [
    'unavailable base',
    (forecast) => {
      forecast.available = false;
    },
  ],
  [
    'wrong target',
    (forecast) => {
      forecast.target++;
    },
  ],
  [
    'wrong reference market',
    (forecast) => {
      forecast.kalshi.marketTicker += '-OTHER';
    },
  ],
  [
    'future reference',
    (forecast) => {
      forecast.kalshi.referenceAt++;
    },
  ],
  [
    'expired',
    (_, input) => {
      input.now = END;
    },
  ],
  [
    'not open',
    (_, input) => {
      input.now = END - 900_001;
    },
  ],
])('%s cannot be rescued by an otherwise valid market quote', (_, change) => {
  const { forecast, input } = fixture();
  change(forecast, input);
  for (const variant of Object.values(getMarketResearchVariants(forecast, input))) {
    expect(variant.available).toBe(false);
    expect(variant.aboveProbability).toBeNull();
  }
});

test('the age and spread boundaries are inclusive and deliberately stricter than the comparator', () => {
  const { forecast, input } = fixture();
  input.quote.receivedAt = NOW - 15_000;
  input.quote.yesBid = 0.65;
  input.quote.yesAsk = 0.75;
  expect(getMarketResearchVariants(forecast, input)['market-blend'].appliedMarket).toBe(true);
});

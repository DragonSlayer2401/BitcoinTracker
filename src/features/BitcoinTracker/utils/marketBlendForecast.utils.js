import { isKalshiContract, KALSHI_OUTCOME_DEFINITION } from './kalshi/contract.utils';
import { getKalshiMarketProbability } from './kalshi/marketQuote.utils';
import { MARKET_BLEND_POLICY } from './researchVariantConfig.utils';

const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;

/** Compare a contemporaneous midpoint without changing the settlement event or its price model. */
export function getMarketResearchVariants(forecast, { market, quote, now } = {}) {
  const policy = MARKET_BLEND_POLICY;
  const horizonMinutes = (market?.expiresAt - now) / 60_000;
  const isBaseAvailable =
    forecast?.available === true &&
    probability(forecast.aboveProbability) &&
    probability(forecast.belowProbability) &&
    Math.abs(forecast.aboveProbability + forecast.belowProbability - 1) <= 1e-9 &&
    isKalshiContract(market) &&
    forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    forecast.kalshi?.marketTicker === market.ticker &&
    timestamp(forecast.kalshi.referenceAt) &&
    forecast.kalshi.referenceAt <= now &&
    Number.isFinite(forecast.kalshi.referencePrice) &&
    forecast.kalshi.referencePrice > 0 &&
    forecast.target === market.target &&
    forecast.expiresAt === market.expiresAt &&
    timestamp(now) &&
    now >= market.startsAt &&
    horizonMinutes > 0 &&
    horizonMinutes <= policy.maximumHorizonMinutes;
  const quoteAgeMs = timestamp(quote?.receivedAt) && timestamp(now) ? now - quote.receivedAt : null;
  const spread =
    probability(quote?.yesBid) && probability(quote?.yesAsk) ? quote.yesAsk - quote.yesBid : null;
  const midpoint = getKalshiMarketProbability(quote, market, now);
  const reason = !isBaseAvailable
    ? 'A matching available settlement forecast is required.'
    : midpoint === null
      ? 'A fresh matching Kalshi bid and ask are unavailable.'
      : quoteAgeMs > policy.maximumQuoteAgeMs
        ? 'The Kalshi quote is too old for the market-blend experiment.'
        : spread > policy.maximumSpread + 1e-12
          ? 'The Kalshi bid–ask spread is too wide for the market-blend experiment.'
          : null;
  const hasMarketProbability = reason === null;
  const weight = hasMarketProbability
    ? policy.minimumMarketWeight +
      (policy.maximumMarketWeight - policy.minimumMarketWeight) *
        (1 - horizonMinutes / policy.maximumHorizonMinutes)
    : 0;
  const combined = forecast?.researchVariants?.combined;
  const common = {
    modelVersion: forecast?.modelVersion ?? null,
    referenceSource: forecast?.kalshi?.referenceSource ?? null,
    referencePrice: forecast?.kalshi?.referencePrice ?? null,
    referenceAt: forecast?.kalshi?.referenceAt ?? null,
    minuteVolatility: forecast?.kalshi?.minuteVolatility ?? null,
    basisLogDeviation: forecast?.kalshi?.basisLogDeviation ?? null,
    // A binary midpoint blend does not imply a distribution for the settlement price.
    expectedSettlementAverage: null,
    settlementStandardDeviation: null,
    settlementLowerBound: null,
    settlementUpperBound: null,
    marketProbability: hasMarketProbability ? midpoint : null,
    marketQuoteAgeMs: quoteAgeMs,
    marketSpread: spread,
    marketReason: reason,
  };
  const blendedProbability = isBaseAvailable
    ? hasMarketProbability
      ? (1 - weight) * forecast.aboveProbability + weight * midpoint
      : forecast.aboveProbability
    : null;
  return {
    'market-blend': {
      ...common,
      policyVersion: policy.version,
      available: isBaseAvailable,
      reason: isBaseAvailable ? null : reason,
      aboveProbability: blendedProbability,
      belowProbability:
        blendedProbability === null
          ? null
          : hasMarketProbability
            ? 1 - blendedProbability
            : forecast.belowProbability,
      appliedSpot: Boolean(isBaseAvailable && forecast.pressure?.applied),
      appliedFutures: Boolean(isBaseAvailable && forecast.derivatives?.applied),
      appliedMarket: hasMarketProbability,
      marketWeight: weight,
      fallbacks: [...(combined?.fallbacks ?? []), ...(reason ? [reason] : [])],
    },
    'market-only': {
      ...common,
      policyVersion: 'kalshi-market-midpoint-v1',
      available: hasMarketProbability,
      reason,
      aboveProbability: hasMarketProbability ? midpoint : null,
      belowProbability: hasMarketProbability ? 1 - midpoint : null,
      appliedSpot: false,
      appliedFutures: false,
      appliedMarket: hasMarketProbability,
      marketWeight: hasMarketProbability ? 1 : 0,
      fallbacks: reason ? [reason] : [],
    },
  };
}

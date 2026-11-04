import { getMarketConditions } from '../marketConditions.utils';

/** Keep index price behavior and exchange-only volume/liquidity clearly separated. */
export function getKalshiMarketConditions(input = {}) {
  const coinbase = getMarketConditions(input);
  const benchmark = input.forecast?.kalshi?.benchmarkConditions;
  if (!benchmark?.available) return { ...coinbase, priceSource: 'coinbase-candles' };
  return {
    ...benchmark,
    priceSource: 'cf-brti-history',
    volumeSource: coinbase.available ? 'coinbase' : null,
    features: { ...(coinbase.available ? coinbase.features : {}), ...benchmark.features },
  };
}

export function hasIndependentKalshiBenchmark(forecast) {
  return Boolean(
    forecast?.available &&
    forecast.kalshi?.referenceSource === 'cf-brti' &&
    forecast.kalshi?.volatilitySource === 'cf-brti',
  );
}

/** The quote saved with a call must describe the price that actually anchors its forecast. */
export function getKalshiReferenceQuote(forecast, ticker) {
  const reference = forecast?.kalshi;
  if (
    reference?.referenceSource === 'cf-brti' &&
    Number.isFinite(reference.referencePrice) &&
    reference.referencePrice > 0 &&
    Number.isSafeInteger(reference.referenceAt)
  ) {
    return {
      price: reference.referencePrice,
      time: reference.referenceAt,
      receivedAt: reference.referenceReceivedAt ?? reference.referenceAt,
      source: 'cf-brti',
    };
  }
  return ticker;
}

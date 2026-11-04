import { isKalshiContract } from './contract.utils';

const probability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const fresh = (time, now) =>
  Number.isSafeInteger(time) && time > 0 && time <= now && now - time <= 30_000;

/** Preserve the contemporaneous order-book prices separately from immutable settlement rules. */
export function getKalshiQuoteSnapshot(market, now) {
  if (!isKalshiContract(market) || !fresh(market.receivedAt, now)) return null;
  return {
    marketTicker: market.ticker,
    target: market.target,
    expiresAt: market.expiresAt,
    receivedAt: market.receivedAt,
    ...Object.fromEntries(
      ['yesBid', 'yesAsk', 'noBid', 'noAsk'].map((name) => [
        name,
        probability(market[name]) ? market[name] : null,
      ]),
    ),
  };
}

/** A bid/ask midpoint is a comparison benchmark, not a calibrated probability or executable price. */
export function getKalshiMarketProbability(quote, contract, capturedAt) {
  if (
    !isKalshiContract(contract) ||
    !quote ||
    !fresh(quote.receivedAt, capturedAt) ||
    quote.marketTicker !== contract.ticker ||
    quote.target !== contract.target ||
    quote.expiresAt !== contract.expiresAt ||
    !probability(quote.yesBid) ||
    !probability(quote.yesAsk) ||
    quote.yesBid > quote.yesAsk ||
    quote.yesAsk <= 0 ||
    quote.yesBid >= 1
  )
    return null;
  return (quote.yesBid + quote.yesAsk) / 2;
}

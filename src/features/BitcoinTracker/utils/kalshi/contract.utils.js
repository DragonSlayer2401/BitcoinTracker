export const KALSHI_OUTCOME_DEFINITION = 'kalshi-btc15m-brti-average-v1';
export const KALSHI_SERIES = 'KXBTC15M';

const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const price = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e9;
const ticker = (value) => typeof value === 'string' && /^KXBTC15M-[A-Z0-9-]{1,80}$/.test(value);

/** Only the verified Bitcoin 15-minute contract is supported by this model. */
export function isKalshiContract(market) {
  return Boolean(
    market &&
    ticker(market.ticker) &&
    ticker(market.eventTicker) &&
    market.seriesTicker === KALSHI_SERIES &&
    market.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    market.rulesVerified === true &&
    market.comparison === 'greater_or_equal' &&
    market.roundDigits === 2 &&
    price(market.target) &&
    Math.abs(market.target * 100 - Math.round(market.target * 100)) < 1e-5 &&
    timestamp(market.startsAt) &&
    timestamp(market.expiresAt) &&
    market.startsAt % 1000 === 0 &&
    market.expiresAt % 1000 === 0 &&
    market.expiresAt - market.startsAt === 900_000,
  );
}

/** Persist settlement identity, never mutable quotes or an eventual result in a decision. */
export function getKalshiContract(market) {
  if (!isKalshiContract(market)) return null;
  return Object.fromEntries(
    [
      'ticker',
      'eventTicker',
      'seriesTicker',
      'target',
      'startsAt',
      'expiresAt',
      'comparison',
      'roundDigits',
      'outcomeDefinition',
      'rulesVerified',
    ].map((key) => [key, market[key]]),
  );
}

export function getKalshiOutcome(market, now) {
  const contract = getKalshiContract(market);
  // A price or a closed market is not a finalized exchange result.
  if (
    !contract ||
    !['settled', 'finalized'].includes(market.status) ||
    !['yes', 'no'].includes(market.result) ||
    !price(market.settlementPrice) ||
    !timestamp(now) ||
    now < market.expiresAt ||
    !timestamp(market.receivedAt) ||
    market.receivedAt < market.expiresAt ||
    market.receivedAt > now
  )
    return null;
  const outcome = {
    status: 'observed',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    marketTicker: market.ticker,
    target: market.target,
    expiresAt: market.expiresAt,
    observedPrice: market.settlementPrice,
    observedAt: market.expiresAt,
    outcome: market.result === 'yes' ? 'above' : 'below',
    result: market.result,
    confirmedThrough: market.receivedAt,
    settledAt: timestamp(market.settledAt) ? market.settledAt : market.receivedAt,
    comparison: 'greater_or_equal',
    roundDigits: 2,
  };
  return isVerifiedKalshiOutcome(outcome, contract, now) ? outcome : null;
}

export function isVerifiedKalshiOutcome(outcome, contract, now) {
  return Boolean(
    isKalshiContract(contract) &&
    outcome?.status === 'observed' &&
    outcome.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    outcome.marketTicker === contract.ticker &&
    outcome.target === contract.target &&
    outcome.expiresAt === contract.expiresAt &&
    outcome.observedAt === contract.expiresAt &&
    price(outcome.observedPrice) &&
    ['yes', 'no'].includes(outcome.result) &&
    outcome.outcome === (outcome.result === 'yes' ? 'above' : 'below') &&
    outcome.comparison === contract.comparison &&
    outcome.roundDigits === contract.roundDigits &&
    timestamp(now) &&
    timestamp(outcome.confirmedThrough) &&
    timestamp(outcome.settledAt) &&
    outcome.settledAt >= contract.expiresAt &&
    outcome.confirmedThrough >= outcome.settledAt &&
    outcome.confirmedThrough <= now,
  );
}

export function isSameKalshiContract(left, right) {
  const first = getKalshiContract(left);
  const second = getKalshiContract(right);
  return Boolean(first && second && Object.keys(first).every((key) => first[key] === second[key]));
}

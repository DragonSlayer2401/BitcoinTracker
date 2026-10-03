import { isKalshiContract } from './contract.utils';

export const PURCHASE_BOOK_MAX_AGE_MS = 15_000;
export const MAXIMUM_PURCHASE_CONTRACTS = 10_000;
const ceilingDivide = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

/** Fees accumulate across one order; rounding each contract to a cent overstates its cost. */
export function getPurchaseFeeEstimate(fills, fee, accountType, now) {
  if (
    !fee?.available ||
    fee.type !== 'quadratic' ||
    !Number.isFinite(fee.multiplier) ||
    fee.multiplier < 0 ||
    fee.multiplier > 100 ||
    !Number.isSafeInteger(fee.checkedAt) ||
    fee.checkedAt > now ||
    now - fee.checkedAt > 30_000 ||
    !Number.isSafeInteger(fee.validUntil) ||
    fee.validUntil <= now
  )
    return null;
  if (!['direct', 'intermediary'].includes(accountType)) return null;
  const multiplier = BigInt(Math.round(fee.multiplier * 10_000));
  let costMicros = 0n;
  let tradeFeeMicros = 0n;
  for (const { price, quantity } of fills) {
    const priceUnits = BigInt(Math.round(price * 10_000));
    const quantityUnits = BigInt(Math.round(quantity * 100));
    costMicros += priceUnits * quantityUnits;
    tradeFeeMicros += ceilingDivide(
      7n * multiplier * quantityUnits * priceUnits * (10_000n - priceUnits),
      10_000_000_000n,
    );
  }
  const balanceUnit = accountType === 'direct' ? 100n : 10_000n;
  const totalMicros = ceilingDivide(costMicros + tradeFeeMicros, balanceUnit) * balanceUnit;
  return Number(totalMicros - costMicros) / 1_000_000;
}

function getSideValue(asks, contracts, probability, fee, accountType, now) {
  let remaining = contracts;
  const fills = [];
  for (const level of asks) {
    const quantity = Math.min(remaining, level.quantity);
    if (quantity > 0) fills.push({ price: level.price, quantity });
    remaining = Number((remaining - quantity).toFixed(2));
    if (remaining === 0) break;
  }
  const filledQuantity = contracts - remaining;
  const cost = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const isFullyCovered = remaining === 0;
  const exchangeFee = isFullyCovered ? getPurchaseFeeEstimate(fills, fee, accountType, now) : null;
  // Broker-specific charges are unknown even when the exchange portion can be estimated.
  const netAvailable = exchangeFee !== null && accountType === 'direct';
  return {
    probability,
    bestAsk: asks[0]?.price ?? null,
    filledQuantity,
    isFullyCovered,
    cost: Number(cost.toFixed(6)),
    averageAsk: filledQuantity > 0 ? cost / filledQuantity : null,
    exchangeFee,
    grossExpectedValue: isFullyCovered ? probability * contracts - cost : null,
    netExpectedValue: netAvailable ? probability * contracts - cost - exchangeFee : null,
    breakEvenProbability: netAvailable ? (cost + exchangeFee) / contracts : null,
    maximumLoss: netAvailable ? cost + exchangeFee : null,
    profitIfWins: netAvailable ? contracts - cost - exchangeFee : null,
  };
}

/** Compare one hypothetical buy with displayed depth, never a midpoint or a promised fill. */
export function getKalshiPurchaseValue({
  book,
  contract,
  aboveProbability,
  contracts,
  accountType,
  now,
}) {
  const unavailable = (reason) => ({ available: false, reason });
  if (
    !Number.isSafeInteger(now) ||
    !isKalshiContract(contract) ||
    now < contract.startsAt ||
    now >= contract.expiresAt
  ) {
    return unavailable('Purchase value is available only during the matching Kalshi event.');
  }
  if (!Number.isInteger(contracts) || contracts < 1 || contracts > MAXIMUM_PURCHASE_CONTRACTS) {
    return unavailable(
      `Enter a whole number from 1 to ${MAXIMUM_PURCHASE_CONTRACTS.toLocaleString('en-US')} contracts.`,
    );
  }
  if (!Number.isFinite(aboveProbability) || aboveProbability < 0 || aboveProbability > 1) {
    return unavailable('Waiting for a current estimate for this exact contract.');
  }
  if (
    !book ||
    book.ticker !== contract.ticker ||
    !Number.isSafeInteger(book.receivedAt) ||
    book.receivedAt > now + 1000 ||
    now - book.receivedAt > PURCHASE_BOOK_MAX_AGE_MS
  ) {
    return unavailable('Waiting for fresh order-book prices for this contract.');
  }
  if (
    ![book.yesAsks, book.noAsks].every(
      (levels) =>
        Array.isArray(levels) &&
        levels.length <= 100 &&
        levels.every(
          (level, index) =>
            Number.isFinite(level?.price) &&
            level.price > 0 &&
            level.price < 1 &&
            Number.isFinite(level.quantity) &&
            level.quantity > 0 &&
            level.quantity <= 1_000_000_000 &&
            Math.abs(level.price * 10_000 - Math.round(level.price * 10_000)) < 1e-7 &&
            Math.abs(level.quantity * 100 - Math.round(level.quantity * 100)) < 1e-5 &&
            (!index || level.price > levels[index - 1].price),
        ),
    )
  ) {
    return unavailable('Purchase depth is invalid. Refresh prices before comparing value.');
  }
  return {
    available: true,
    contracts,
    receivedAt: book.receivedAt,
    yes: getSideValue(book.yesAsks, contracts, aboveProbability, book.fee, accountType, now),
    no: getSideValue(book.noAsks, contracts, 1 - aboveProbability, book.fee, accountType, now),
    feeReason: !book.fee?.available
      ? (book.fee?.reason ?? 'Fee data is unavailable.')
      : accountType === 'intermediary'
        ? 'Your broker may add charges; net value is unavailable.'
        : accountType !== 'direct'
          ? 'Choose your account type to estimate fees.'
          : now >= book.fee.validUntil
            ? 'Fee information needs refreshing.'
            : null,
  };
}

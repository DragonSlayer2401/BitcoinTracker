import {
  formatDecimalUnits,
  getPriceGridPoints,
  parseDecimalUnits,
  snapPriceToGrid,
} from '@/utils/fixedPoint.utils';
import {
  createTradingDomainRecord,
  isTradableMarketSpecification,
  isValidVenuePrice,
  isValidVenueQuantity,
} from '@/utils/tradingDomain.utils';

const decimalUnits = (value, scale) =>
  typeof value === 'number' && Number.isFinite(value)
    ? parseDecimalUnits(String(value), scale)
    : null;

/** The legacy numeric boundary must match the verified, exact market identity. */
export const getTradingSpecificationProblem = (contract) => {
  const specification = contract?.specification;
  if (!isTradableMarketSpecification(specification)) return 'market_specification_unverified';
  const target = decimalUnits(contract.target, 2);
  const specifiedTarget = parseDecimalUnits(specification.target?.value, 2);
  if (
    specification.marketTicker !== contract.ticker ||
    specification.eventTicker !== contract.eventTicker ||
    specification.seriesTicker !== contract.seriesTicker ||
    specification.timestamps.opensAt !== contract.startsAt ||
    specification.timestamps.closesAt !== contract.expiresAt ||
    target === null ||
    target !== specifiedTarget
  )
    return 'market_specification_conflict';
  return null;
};

/** API price ranges describe the YES book; NO prices are its exact complements. */
export const getTradingPriceGrid = (contract, side = 'yes') => {
  if (getTradingSpecificationProblem(contract) || !['yes', 'no'].includes(side)) return null;
  const ranges = contract.specification.priceGrid;
  return side === 'yes'
    ? ranges
    : ranges
        .map(({ start, end, step }) => ({
          start: String(10_000n - BigInt(end)),
          end: String(10_000n - BigInt(start)),
          step,
        }))
        .reverse();
};

export const isTradingQuantityValid = (quantity, contract) => {
  if (getTradingSpecificationProblem(contract)) return false;
  const units = decimalUnits(quantity, 2);
  return units !== null && isValidVenueQuantity(String(units), contract.specification);
};

export const isTradingPriceValid = (price, contract, side = 'yes') => {
  const units = decimalUnits(price, 4);
  return Boolean(
    !getTradingSpecificationProblem(contract) &&
    ['yes', 'no'].includes(side) &&
    units !== null &&
    isValidVenuePrice(String(units), contract.specification, side.toUpperCase()),
  );
};

export const getTradingBookRulesProblem = (contract, book) => {
  const problem = getTradingSpecificationProblem(contract);
  if (problem) return problem;
  for (const side of ['yes', 'no']) {
    const levels = book?.[`${side}Asks`];
    if (
      !Array.isArray(levels) ||
      levels.some(
        (level) =>
          !isTradingPriceValid(level?.price, contract, side) ||
          !isTradingQuantityValid(level?.quantity, contract),
      )
    )
      return 'invalid_market_price_or_quantity';
    try {
      levels.forEach((level, index) => {
        createTradingDomainRecord(
          'quote',
          {
            id: `${contract.ticker}:${side}:${book.receivedAt}:${index}`,
            marketTicker: contract.ticker,
            specificationVersion: contract.specification.version,
            source: { id: 'kalshi', kind: 'official' },
            observedAt: book.receivedAt,
            receivedAt: book.receivedAt,
            observationClock: 'local-receipt',
            sourceObservedAt: null,
            side: side.toUpperCase(),
            bookSide: 'ask',
            priceUnits: String(decimalUnits(level.price, 4)),
            quantityUnits: String(decimalUnits(level.quantity, 2)),
            validUntil: Math.min(book.receivedAt + 15_000, contract.expiresAt),
          },
          contract.specification,
        );
      });
    } catch {
      return 'invalid_market_quote';
    }
  }
  return null;
};

export const getTradingPricePoints = (contract, side = 'yes') => {
  const grid = getTradingPriceGrid(contract, side);
  return grid === null
    ? []
    : getPriceGridPoints(grid, { minimum: '1', maximum: '9999' }).map((units) =>
        Number(formatDecimalUnits(units, 4)),
      );
};

export const getTradingGridPrice = (price, contract, side, direction, { strict = false } = {}) => {
  const grid = getTradingPriceGrid(contract, side);
  let units = decimalUnits(price, 4);
  if (!grid || units === null) return null;
  if (strict) units += direction === 'up' ? 1n : -1n;
  const snapped = snapPriceToGrid(units, grid, direction);
  return snapped === null || BigInt(snapped) <= 0n || BigInt(snapped) >= 10_000n
    ? null
    : Number(formatDecimalUnits(snapped, 4));
};

export const getTradingComplementPrice = (price) => {
  const units = decimalUnits(price, 4);
  return units === null ? null : Number(formatDecimalUnits(10_000n - units, 4));
};

/** Adverse snapshot pricing follows the actual grid; no synthetic off-grid fill is created. */
export const getTradingAdverseFills = ({ levels, quantity, slippage, contract, side, action }) => {
  const grid = getTradingPriceGrid(contract, side);
  let remaining = decimalUnits(quantity, 2);
  const slippageUnits = decimalUnits(slippage, 4);
  if (
    !grid ||
    !isTradingQuantityValid(quantity, contract) ||
    remaining === null ||
    slippageUnits === null ||
    !['buy', 'sell'].includes(action)
  )
    return null;
  const fills = [];
  for (const level of levels) {
    const priceUnits = decimalUnits(level.price, 4);
    const available = decimalUnits(level.quantity, 2);
    if (priceUnits === null || available === null) return null;
    const filled = available < remaining ? available : remaining;
    const price = snapPriceToGrid(
      action === 'buy' ? priceUnits + slippageUnits : priceUnits - slippageUnits,
      grid,
      action === 'buy' ? 'up' : 'down',
    );
    if (price === null || BigInt(price) <= 0n || BigInt(price) >= 10_000n) return null;
    if (filled > 0n) {
      if (!isValidVenueQuantity(String(filled), contract.specification)) return null;
      fills.push({
        price: Number(formatDecimalUnits(price, 4)),
        quantity: Number(formatDecimalUnits(filled, 2)),
      });
    }
    remaining -= filled;
    if (remaining === 0n) return fills;
  }
  return null;
};

/** Validate the decision and paper-order boundary without submitting or creating an exchange order. */
export const getTradingActionProblem = ({
  contract,
  action,
  side,
  quantity,
  limitPrice,
  now,
  position,
}) => {
  const problem = getTradingSpecificationProblem(contract);
  if (problem) return problem;
  const common = {
    id: `${contract.ticker}:${now}:${action}`,
    marketTicker: contract.ticker,
    specificationVersion: contract.specification.version,
    source: { id: 'paper-simulator', kind: 'paper' },
    observedAt: now,
    receivedAt: now,
    side: side?.toUpperCase(),
    action: action?.toUpperCase(),
    quantityUnits: String(decimalUnits(quantity, 2)),
    limitPriceUnits: String(decimalUnits(limitPrice, 4)),
  };
  try {
    createTradingDomainRecord(
      'decision',
      {
        ...common,
        position: position
          ? {
              state: 'held',
              positionId: position.id,
              quantityUnits: String(decimalUnits(position.quantity, 2)),
            }
          : { state: 'flat', positionId: null, quantityUnits: '0' },
        reason: 'existing_strategy_assessment',
        validUntil: Math.min(now + 15_000, contract.expiresAt),
      },
      contract.specification,
    );
    createTradingDomainRecord(
      'order',
      {
        ...common,
        mode: 'paper',
        status: 'pending',
        filledQuantityUnits: '0',
      },
      contract.specification,
    );
  } catch {
    return 'invalid_market_price_or_quantity';
  }
  return null;
};

export const getTradingFillGrossUnits = (fills) => {
  let gross = 0n;
  for (const fill of fills) {
    const price = decimalUnits(fill.price, 4);
    const quantity = decimalUnits(fill.quantity, 2);
    if (price === null || quantity === null) return null;
    gross += price * quantity;
  }
  return gross;
};

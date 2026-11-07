/** Exact decimal boundaries. BigInt stays inside calculations; records serialize integer strings. */
const isScale = (scale) => Number.isInteger(scale) && scale >= 0 && scale <= 18;

export const parseIntegerUnits = (value) => {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || value.length > 80 || !/^(?:0|-?[1-9]\d*)$/.test(value))
    return null;
  return BigInt(value);
};

/** Never multiply a binary floating-point input to obtain monetary units. */
export const parseDecimalUnits = (value, scale) => {
  if (
    !isScale(scale) ||
    typeof value !== 'string' ||
    value.length > 100 ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  )
    return null;
  const isNegative = value.startsWith('-');
  const [whole, fraction = ''] = (isNegative ? value.slice(1) : value).split('.');
  if (fraction.length > scale) return null;
  const units = BigInt(whole + fraction.padEnd(scale, '0'));
  return isNegative ? -units : units;
};

export const formatDecimalUnits = (value, scale) => {
  const units = parseIntegerUnits(value);
  if (units === null || !isScale(scale)) return null;
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`;
};

/** Rounding policy is required; an undocumented tie rule must never be chosen implicitly. */
export const roundRationalUnits = (numerator, denominator, mode) => {
  const amount = parseIntegerUnits(numerator);
  const divisor = parseIntegerUnits(denominator);
  if (amount === null || divisor === null || divisor <= 0n) return null;
  if (!['exact', 'toward-zero', 'floor', 'ceil', 'half-up', 'half-even'].includes(mode))
    return null;
  const quotient = amount / divisor;
  const remainder = amount % divisor;
  if (remainder === 0n) return quotient;
  if (mode === 'exact') return null;
  if (mode === 'toward-zero') return quotient;
  if (mode === 'floor') return quotient - (amount < 0n ? 1n : 0n);
  if (mode === 'ceil') return quotient + (amount > 0n ? 1n : 0n);
  const magnitude = remainder < 0n ? -remainder : remainder;
  const difference = magnitude * 2n - divisor;
  const roundsAway =
    difference > 0n || (difference === 0n && (mode === 'half-up' || quotient % 2n !== 0n));
  return quotient + (roundsAway ? (amount < 0n ? -1n : 1n) : 0n);
};

export const roundDecimalUnits = (value, scale, mode) => {
  if (typeof value !== 'string' || !isScale(scale)) return null;
  const sourceScale = value.split('.')[1]?.length ?? 0;
  const units = parseDecimalUnits(value, sourceScale);
  if (units === null) return null;
  if (sourceScale <= scale) return units * 10n ** BigInt(scale - sourceScale);
  return roundRationalUnits(units, 10n ** BigInt(sourceScale - scale), mode);
};

export const getPriceQuantityMoneyUnits = (priceUnits, quantityUnits) => {
  const price = parseIntegerUnits(priceUnits);
  const quantity = parseIntegerUnits(quantityUnits);
  // 10^-4 USD/contract × 10^-2 contracts = 10^-6 USD.
  return price === null || quantity === null || price < 0n || quantity < 0n
    ? null
    : (price * quantity).toString();
};

const readPriceRanges = (ranges) => {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 100) return null;
  const parsed = [];
  for (const range of ranges) {
    const start = parseIntegerUnits(range?.start);
    const end = parseIntegerUnits(range?.end);
    const step = parseIntegerUnits(range?.step);
    if (
      start === null ||
      end === null ||
      step === null ||
      start < 0n ||
      end > 10_000n ||
      start >= end ||
      step <= 0n ||
      step > end - start ||
      (end - start) % step !== 0n ||
      (parsed.length > 0 && parsed.at(-1).end !== start)
    )
      return null;
    parsed.push({ start, end, step });
  }
  return parsed[0].start === 0n && parsed.at(-1).end === 10_000n ? parsed : null;
};

export const isValidPriceGrid = (ranges) => readPriceRanges(ranges) !== null;

export const isOnPriceGrid = (priceUnits, ranges) => {
  const price = parseIntegerUnits(priceUnits);
  const parsed = readPriceRanges(ranges);
  return Boolean(
    price !== null &&
    parsed &&
    parsed.some(
      ({ start, end, step }) => price >= start && price <= end && (price - start) % step === 0n,
    ),
  );
};

/** The returned price is an actual point in metadata, never a guessed global tick. */
export const snapPriceToGrid = (priceUnits, ranges, direction) => {
  const price = parseIntegerUnits(priceUnits);
  const parsed = readPriceRanges(ranges);
  if (price === null || !parsed || !['up', 'down'].includes(direction)) return null;
  let selected = null;
  for (const { start, end, step } of parsed) {
    if ((direction === 'up' && price > end) || (direction === 'down' && price < start)) continue;
    const bounded = price < start ? start : price > end ? end : price;
    const offset = bounded - start;
    const remainder = offset % step;
    const candidate =
      start + (offset / step + (direction === 'up' && remainder > 0n ? 1n : 0n)) * step;
    if (candidate < start || candidate > end) continue;
    if (selected === null || (direction === 'up' ? candidate < selected : candidate > selected))
      selected = candidate;
  }
  return selected?.toString() ?? null;
};

export const getPriceGridPoints = (ranges, { minimum = '1', maximum = '9999' } = {}) => {
  const parsed = readPriceRanges(ranges);
  const lower = parseIntegerUnits(minimum);
  const upper = parseIntegerUnits(maximum);
  if (!parsed || lower === null || upper === null || lower > upper) return [];
  const prices = new Set();
  for (const { start, end, step } of parsed) {
    for (let price = start; price <= end; price += step) {
      if (price >= lower && price <= upper) prices.add(price.toString());
    }
  }
  return [...prices].sort((first, second) => (BigInt(first) < BigInt(second) ? -1 : 1));
};

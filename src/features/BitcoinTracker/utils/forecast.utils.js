const MINUTE_IN_MILLISECONDS = 60_000;
const HORIZON_MINUTES = 15;
const MAXIMUM_CANDLES = 120;
const MINIMUM_RETURNS = 60;
const MAXIMUM_QUOTE_AGE = 20_000;
const MAXIMUM_FUTURE_QUOTE_OFFSET = 5_000;
const MAXIMUM_CANDLE_AGE = 120_000;
const MINIMUM_MINUTE_VOLATILITY = 0.00001;
const MAXIMUM_MINUTE_VOLATILITY = 0.05;
const MAXIMUM_ABSOLUTE_MINUTE_RETURN = 0.2;
const CENTRAL_80_PERCENT_NORMAL_QUANTILE = 1.2815515655446004;
const MODEL_VERSION = 'zero-drift-log-return-v1';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositiveNumber = (value) => isFiniteNumber(value) && value > 0;

function getUnavailableForecast(reason, sampleCount = 0, horizonMinutes = HORIZON_MINUTES) {
  return {
    available: false,
    reason,
    aboveProbability: null,
    belowProbability: null,
    direction: null,
    volatility: null,
    lowerBound: null,
    upperBound: null,
    sampleCount,
    horizonMinutes,
    modelVersion: MODEL_VERSION,
  };
}

function hasValidCandlePrices(candle) {
  return (
    isPositiveNumber(candle.open) &&
    isPositiveNumber(candle.high) &&
    isPositiveNumber(candle.low) &&
    isPositiveNumber(candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    isFiniteNumber(candle.volume) &&
    candle.volume >= 0
  );
}

function hasFreshTimestamp(time, now) {
  return (
    isPositiveNumber(time) &&
    now - time <= MAXIMUM_QUOTE_AGE &&
    time - now <= MAXIMUM_FUTURE_QUOTE_OFFSET
  );
}

// Standard normal CDF approximation; absolute error is below 7.5e-8.
function getNormalCumulativeProbability(value) {
  if (value === 0) {
    return 0.5;
  }

  const magnitude = Math.abs(value);
  const fraction = 1 / (1 + 0.2316419 * magnitude);
  const density = Math.exp((-magnitude * magnitude) / 2) / Math.sqrt(2 * Math.PI);
  const tail =
    density *
    fraction *
    (0.31938153 +
      fraction *
        (-0.356563782 +
          fraction * (1.781477937 + fraction * (-1.821255978 + fraction * 1.330274429))));

  return value > 0 ? 1 - tail : tail;
}

/**
 * A zero-drift log-return baseline, not a calibrated accuracy estimate.
 * Candle times are minute-start Unix milliseconds, in ascending order.
 * sampleCount counts one-minute returns. volatility is the projected
 * requested-horizon log-return standard deviation, expressed as a decimal.
 */
export function getForecast({ candles, ticker, target, now, horizonMinutes = HORIZON_MINUTES }) {
  if (!isPositiveNumber(horizonMinutes) || horizonMinutes > HORIZON_MINUTES) {
    return getUnavailableForecast(
      'The forecast horizon must be greater than zero and no more than 15 minutes.',
      0,
      null,
    );
  }

  if (!isPositiveNumber(now)) {
    return getUnavailableForecast('A valid current time is required.', 0, horizonMinutes);
  }

  if (!isPositiveNumber(target) || target > 1_000_000_000) {
    return getUnavailableForecast(
      'Enter a target price greater than zero and no more than $1 billion.',
      0,
      horizonMinutes,
    );
  }

  if (
    !ticker ||
    !isPositiveNumber(ticker.price) ||
    !isPositiveNumber(ticker.bid) ||
    !isPositiveNumber(ticker.ask) ||
    ticker.bid > ticker.ask ||
    !isFiniteNumber(ticker.volume) ||
    ticker.volume < 0
  ) {
    return getUnavailableForecast('Waiting for a valid market quote.', 0, horizonMinutes);
  }

  if (!hasFreshTimestamp(ticker.time, now) || !hasFreshTimestamp(ticker.receivedAt, now)) {
    return getUnavailableForecast(
      'The market quote is stale or its timestamp is invalid.',
      0,
      horizonMinutes,
    );
  }

  if (!Array.isArray(candles)) {
    return getUnavailableForecast(
      'Waiting for completed one-minute price history.',
      0,
      horizonMinutes,
    );
  }

  if (
    candles.some(
      (candle) =>
        !candle ||
        !isFiniteNumber(candle.time) ||
        candle.time < 0 ||
        candle.time % MINUTE_IN_MILLISECONDS !== 0,
    )
  ) {
    return getUnavailableForecast(
      'Price history contains an invalid candle timestamp.',
      0,
      horizonMinutes,
    );
  }

  // Never use an unfinished candle, including a candle from a future minute.
  const completedCandles = candles
    .filter((candle) => candle.time + MINUTE_IN_MILLISECONDS <= now)
    .slice(-MAXIMUM_CANDLES);
  const sampleCount = Math.max(0, completedCandles.length - 1);

  if (sampleCount < MINIMUM_RETURNS) {
    return getUnavailableForecast(
      'At least 61 completed one-minute candles are required.',
      sampleCount,
      horizonMinutes,
    );
  }

  if (completedCandles.some((candle) => !hasValidCandlePrices(candle))) {
    return getUnavailableForecast(
      'Price history contains invalid candle values.',
      sampleCount,
      horizonMinutes,
    );
  }

  if (
    completedCandles.some(
      (candle, index) =>
        index > 0 && candle.time - completedCandles[index - 1].time !== MINUTE_IN_MILLISECONDS,
    )
  ) {
    return getUnavailableForecast(
      'Price history has missing, duplicate, or out-of-order minutes.',
      sampleCount,
      horizonMinutes,
    );
  }

  const latestCandle = completedCandles[completedCandles.length - 1];

  if (now - (latestCandle.time + MINUTE_IN_MILLISECONDS) > MAXIMUM_CANDLE_AGE) {
    return getUnavailableForecast('Completed price history is stale.', sampleCount, horizonMinutes);
  }

  const returns = completedCandles
    .slice(1)
    .map((candle, index) => Math.log(candle.close / completedCandles[index].close));

  if (
    returns.some(
      (value) => !Number.isFinite(value) || Math.abs(value) > MAXIMUM_ABSOLUTE_MINUTE_RETURN,
    )
  ) {
    return getUnavailableForecast(
      'Recent price moves are outside this model’s operating range.',
      sampleCount,
      horizonMinutes,
    );
  }

  const averageReturn = returns.reduce((sum, value) => sum + value, 0) / sampleCount;
  const variance =
    returns.reduce((sum, value) => sum + (value - averageReturn) ** 2, 0) / (sampleCount - 1);
  const minuteVolatility = Math.sqrt(variance);

  if (
    !Number.isFinite(minuteVolatility) ||
    minuteVolatility < MINIMUM_MINUTE_VOLATILITY ||
    minuteVolatility > MAXIMUM_MINUTE_VOLATILITY
  ) {
    return getUnavailableForecast(
      'Recent volatility is outside this model’s operating range.',
      sampleCount,
      horizonMinutes,
    );
  }

  const volatility = minuteVolatility * Math.sqrt(horizonMinutes);
  const targetDistance = (Math.log(target) - Math.log(ticker.price)) / volatility;
  const rawAboveProbability = 1 - getNormalCumulativeProbability(targetDistance);
  // Limit model certainty. These bounds do not imply measured reliability.
  const aboveProbability = Math.max(0.01, Math.min(0.99, rawAboveProbability));
  const belowProbability = 1 - aboveProbability;
  const rangeDistance = CENTRAL_80_PERCENT_NORMAL_QUANTILE * volatility;
  const lowerBound = ticker.price * Math.exp(-rangeDistance);
  const upperBound = ticker.price * Math.exp(rangeDistance);

  if (!isPositiveNumber(lowerBound) || !isPositiveNumber(upperBound)) {
    return getUnavailableForecast(
      'The projected price range cannot be calculated safely.',
      sampleCount,
      horizonMinutes,
    );
  }

  return {
    available: true,
    reason: null,
    aboveProbability,
    belowProbability,
    direction:
      Math.max(aboveProbability, belowProbability) < 0.55
        ? 'neutral'
        : aboveProbability > belowProbability
          ? 'above'
          : 'below',
    volatility,
    lowerBound,
    upperBound,
    sampleCount,
    horizonMinutes,
    modelVersion: MODEL_VERSION,
  };
}

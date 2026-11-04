import jStat from 'jstat';
import { getForecast } from './forecast.utils';

const MINUTE = 60_000;
const PARKINSON_RANGE_DIVISOR = 4 * Math.log(2);

// Engineering abstention guards, not fitted thresholds or calibrated probabilities.
export const MARKET_CONDITION_GUARDS = Object.freeze({
  maximumQuoteAgeMs: 20_000,
  maximumQuoteHorizonFraction: 0.1,
  minimumJumpIntervalMs: 1_000,
  minimumMinuteVolatility: 0.00001,
  maximumJumpStandardDeviations: 4,
  maximumShortLongVolatilityRatio: 2.5,
  maximumCandleRangeRatio: 4,
  minimumMomentumPersistence: 0.8,
  minimumAdverseMomentumStandardDeviations: 1,
  ewmaHalfLifeMinutes: 10,
});

const getRootMeanSquare = (values) => Math.sqrt(jStat.mean(values.map((value) => value ** 2)));
const getRangeVolatility = (ranges) =>
  getRootMeanSquare(ranges) / Math.sqrt(PARKINSON_RANGE_DIVISOR);
const getRatio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
const getLogChange = (last, first) => Math.log(last) - Math.log(first);

function getEwmaVolatility(returns) {
  let weightedSquares = 0;
  let totalWeight = 0;
  returns
    .slice(-30)
    .reverse()
    .forEach((value, age) => {
      const weight = 0.5 ** (age / MARKET_CONDITION_GUARDS.ewmaHalfLifeMinutes);
      weightedSquares += weight * value ** 2;
      totalWeight += weight;
    });
  // This is a weighted second moment, retaining directional movement instead of demeaning it.
  return Math.sqrt(weightedSquares / totalWeight);
}

function getUnavailableConditions(reason) {
  return {
    available: false,
    reason: typeof reason === 'string' && reason ? reason : 'Market conditions are unavailable.',
    features: null,
    riskFlags: [],
    canPublish: false,
  };
}

/**
 * Completed-candle features and conservative publication guards. Returns and volatility are
 * logarithmic decimals; all volatility values are per sqrt(minute), unless explicitly named
 * otherwise. Relative volume compares the latest five completed candles with inclusive trailing
 * 30/120-candle means; history may contain only the baseline's minimum 61 candles.
 * These conditions never alter the baseline Above/Below probabilities.
 */
export function getMarketConditions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return getUnavailableConditions('Valid market inputs are required.');
  }
  const { candles, ticker, target, now, horizonMinutes = 15, forecast } = input;
  if (forecast?.available === false) {
    return getUnavailableConditions(forecast.reason || 'The baseline forecast is unavailable.');
  }
  // Reuse the baseline's OHLCV, chronology, freshness, and horizon checks, even if a caller passes
  // a previously available forecast alongside subsequently changed or malformed market data.
  const validatedForecast = getForecast({ candles, ticker, target, now, horizonMinutes });
  if (!validatedForecast.available) return getUnavailableConditions(validatedForecast.reason);

  const completed = candles.filter((candle) => candle.time + MINUTE <= now).slice(-120);
  const latest = completed.at(-1);
  const returns = completed
    .slice(1)
    .map((candle, index) => getLogChange(candle.close, completed[index].close));
  const ranges = completed.map((candle) => getLogChange(candle.high, candle.low));
  const recentReturns = returns.slice(-5);
  const historyReturns = returns.slice(0, -5);
  const historyRanges = ranges.slice(0, -5);
  const logReturn = (minutes) => getLogChange(latest.close, completed.at(-1 - minutes).close);
  const upwardFraction = recentReturns.filter((value) => value > 0).length / recentReturns.length;
  const downwardFraction = recentReturns.filter((value) => value < 0).length / recentReturns.length;
  const logReturn5Minutes = logReturn(5);
  const momentumSign = Math.sign(logReturn5Minutes);
  const baselineMinuteVolatility = validatedForecast.volatility / Math.sqrt(horizonMinutes);
  const recentReturnRootMeanSquare = getRootMeanSquare(returns.slice(-30));
  const rangeVolatility30Minutes = getRangeVolatility(ranges.slice(-30));
  const effectiveMinuteVolatility = Math.max(
    baselineMinuteVolatility,
    recentReturnRootMeanSquare,
    rangeVolatility30Minutes,
    MARKET_CONDITION_GUARDS.minimumMinuteVolatility,
  );
  const shortMinuteVolatility = Math.max(
    getRootMeanSquare(recentReturns),
    getRangeVolatility(ranges.slice(-5)),
  );
  const historyMinuteVolatility = Math.max(
    getRootMeanSquare(historyReturns),
    getRangeVolatility(historyRanges),
    MARKET_CONDITION_GUARDS.minimumMinuteVolatility,
  );
  const shortLongVolatilityRatio = shortMinuteVolatility / historyMinuteVolatility;
  const medianHistoricalRange = jStat.median(ranges.slice(0, -1));
  const latestRangeToMedianRatio =
    ranges.at(-1) /
    Math.max(
      medianHistoricalRange,
      MARKET_CONDITION_GUARDS.minimumMinuteVolatility * Math.sqrt(PARKINSON_RANGE_DIVISOR),
    );
  const jumpElapsedMs = ticker.time - (latest.time + MINUTE);
  const jumpElapsedMinutes =
    jumpElapsedMs < 0
      ? null
      : Math.max(jumpElapsedMs, MARKET_CONDITION_GUARDS.minimumJumpIntervalMs) / MINUTE;
  const jumpLogReturn = jumpElapsedMs < 0 ? null : getLogChange(ticker.price, latest.close);
  const jumpStandardDeviations =
    jumpElapsedMinutes === null
      ? null
      : Math.abs(jumpLogReturn) / (effectiveMinuteVolatility * Math.sqrt(jumpElapsedMinutes));
  const midpoint = ticker.bid / 2 + ticker.ask / 2;
  const tradeTargetSide = Math.sign(ticker.price - target);
  const midpointTargetSide = Math.sign(midpoint - target);
  const latestVolumeMean = jStat.mean(completed.slice(-5).map((candle) => candle.volume));
  const maximumQuoteAgeMs = Math.min(
    MARKET_CONDITION_GUARDS.maximumQuoteAgeMs,
    horizonMinutes * MINUTE * MARKET_CONDITION_GUARDS.maximumQuoteHorizonFraction,
  );
  const features = {
    completedCandleCount: completed.length,
    latestCompletedAt: latest.time + MINUTE,
    logReturn1Minute: logReturn(1),
    logReturn3Minutes: logReturn(3),
    logReturn5Minutes,
    logReturn15Minutes: logReturn(15),
    logReturnAcceleration3Minutes:
      logReturn(3) - getLogChange(completed.at(-4).close, completed.at(-7).close),
    returnSignPersistence5Minutes: Math.max(upwardFraction, downwardFraction),
    upwardReturnFraction5Minutes: upwardFraction,
    downwardReturnFraction5Minutes: downwardFraction,
    momentumDirection5Minutes: momentumSign > 0 ? 'up' : momentumSign < 0 ? 'down' : 'flat',
    relativeVolume5To30Minutes: getRatio(
      latestVolumeMean,
      jStat.mean(completed.slice(-30).map((candle) => candle.volume)),
    ),
    relativeVolume5To120Minutes: getRatio(
      latestVolumeMean,
      jStat.mean(completed.map((candle) => candle.volume)),
    ),
    volumeBaseline120SampleCount: completed.length,
    rangeVolatility5Minutes: getRangeVolatility(ranges.slice(-5)),
    rangeVolatility30Minutes,
    rangeVolatility120Minutes: getRangeVolatility(ranges),
    latestCandleLogRange: ranges.at(-1),
    medianHistoricalLogRange: medianHistoricalRange,
    latestRangeToMedianRatio,
    closePosition:
      latest.high === latest.low ? null : (latest.close - latest.low) / (latest.high - latest.low),
    closeReturnVariance5Minutes: jStat.variance(recentReturns, true),
    closeReturnVarianceHistory: jStat.variance(historyReturns, true),
    recentReturnRootMeanSquare,
    ewmaMinuteVolatility: getEwmaVolatility(returns),
    shortLongVarianceRatio: shortLongVolatilityRatio ** 2,
    shortLongVolatilityRatio,
    baselineMinuteVolatility,
    effectiveMinuteVolatility,
    adverseMomentumStandardDeviations:
      Math.abs(logReturn5Minutes) / (effectiveMinuteVolatility * Math.sqrt(5)),
    currentJumpLogReturn: jumpLogReturn,
    currentJumpElapsedMinutes: jumpElapsedMinutes,
    currentJumpStandardDeviations: jumpStandardDeviations,
    spread: ticker.ask - ticker.bid,
    spreadFraction: (ticker.ask - ticker.bid) / midpoint,
    midpoint,
    lastTradeMidpointLogDifference: getLogChange(ticker.price, midpoint),
    targetDistanceLogReturn: getLogChange(target, ticker.price),
    quoteAgeMs: now - ticker.time,
    receiptAgeMs: now - ticker.receivedAt,
    maximumQuoteAgeMs,
  };
  if (
    Object.values(features).some((value) => typeof value === 'number' && !Number.isFinite(value))
  ) {
    return getUnavailableConditions('Market conditions cannot be calculated safely.');
  }
  const riskFlags = [];
  const addRisk = (code, label, reason) => riskFlags.push({ code, label, reason });

  if (features.quoteAgeMs < 0 || features.receiptAgeMs < 0) {
    addRisk(
      'quote-from-future',
      'Quote clock mismatch',
      'The quote or its receipt is ahead of the current clock.',
    );
  }
  if (features.quoteAgeMs > maximumQuoteAgeMs || features.receiptAgeMs > maximumQuoteAgeMs) {
    addRisk(
      'quote-too-old',
      'Quote too old for this window',
      'The quote must be fresher as the remaining forecast window shortens.',
    );
  }
  if (target >= ticker.bid && target <= ticker.ask) {
    addRisk(
      'target-inside-spread',
      'Target inside the spread',
      'The target is between the current bid and ask, so a side is not well separated.',
    );
  }
  if (tradeTargetSide !== 0 && midpointTargetSide !== 0 && tradeTargetSide !== midpointTargetSide) {
    addRisk(
      'quote-target-disagreement',
      'Trade and midpoint disagree',
      'The last trade and current bid/ask midpoint are on opposite sides of the target.',
    );
  }
  if (jumpElapsedMs < 0) {
    addRisk(
      'negative-jump-interval',
      'Trade behind candle history',
      'The last trade predates the latest completed candle; wait for a current trade.',
    );
  } else if (jumpStandardDeviations > MARKET_CONDITION_GUARDS.maximumJumpStandardDeviations) {
    addRisk(
      'current-price-jump',
      'Current price jump',
      'The move since the latest completed candle exceeds the elapsed-time volatility guard.',
    );
  }
  if (shortLongVolatilityRatio > MARKET_CONDITION_GUARDS.maximumShortLongVolatilityRatio) {
    addRisk(
      'volatility-expansion',
      'Volatility expanding',
      'Recent five-minute movement is much larger than the preceding history.',
    );
  }
  if (latestRangeToMedianRatio > MARKET_CONDITION_GUARDS.maximumCandleRangeRatio) {
    addRisk(
      'extreme-candle-range',
      'Unusually wide candle',
      'The latest completed candle range exceeds the historical range guard.',
    );
  }
  if (
    tradeTargetSide !== 0 &&
    momentumSign === -tradeTargetSide &&
    Math.sign(features.logReturn3Minutes) === momentumSign &&
    features.returnSignPersistence5Minutes >= MARKET_CONDITION_GUARDS.minimumMomentumPersistence &&
    features.adverseMomentumStandardDeviations >=
      MARKET_CONDITION_GUARDS.minimumAdverseMomentumStandardDeviations
  ) {
    addRisk(
      'adverse-momentum',
      'Momentum against the current side',
      'Consistent recent movement is opposing the side of the target favored by the current price.',
    );
  }

  return {
    available: true,
    reason: riskFlags[0]?.reason ?? null,
    features,
    riskFlags,
    canPublish: riskFlags.length === 0,
  };
}

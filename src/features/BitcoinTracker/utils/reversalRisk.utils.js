import { DEADLINE_OUTCOME_DEFINITION } from './outcome.utils';
import { isKalshiContract, KALSHI_OUTCOME_DEFINITION } from './kalshi/contract.utils';
import { getKalshiReferenceQuote } from './kalshi/marketConditions.utils';

const MINUTE = 60_000;
const isProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const isPositive = (value) => Number.isFinite(value) && value > 0;

const unavailable = (reason) => ({
  available: false,
  reason,
  fixedFailureProbability: null,
  currentSideFlipProbability: null,
  currentSide: null,
  oppositeSide: null,
  isAgainstFixedCall: false,
});

/** Deadline outcomes only. A temporary target crossing is a different event. */
export function getReversalRisk({ forecast, fixedForecast, ticker, now } = {}) {
  if (!fixedForecast || !isPositive(fixedForecast.target)) {
    return unavailable('Start a forecast to track risk against its saved target.');
  }
  if (!isPositive(now) || !isPositive(fixedForecast.expiresAt)) {
    return unavailable('A valid forecast deadline is required.');
  }
  if (now >= fixedForecast.expiresAt || ['resolved', 'unobserved'].includes(fixedForecast.status)) {
    return unavailable('The window has ended. Live risk is no longer estimated.');
  }
  if (
    forecast?.target !== fixedForecast.target ||
    forecast?.expiresAt !== fixedForecast.expiresAt
  ) {
    return unavailable('Waiting for an estimate for the saved target and deadline.');
  }
  const usesKalshi = fixedForecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  if (
    (forecast.outcomeDefinition ?? DEADLINE_OUTCOME_DEFINITION) !==
      (fixedForecast.outcomeDefinition ?? DEADLINE_OUTCOME_DEFINITION) ||
    (usesKalshi &&
      (!isKalshiContract(fixedForecast.kalshiMarket) ||
        fixedForecast.kalshiMarket.target !== fixedForecast.target ||
        fixedForecast.kalshiMarket.expiresAt !== fixedForecast.expiresAt ||
        forecast.kalshi?.marketTicker !== fixedForecast.kalshiMarket.ticker))
  ) {
    return unavailable('Waiting for an estimate for the same saved contract and settlement rules.');
  }
  const quote = usesKalshi ? getKalshiReferenceQuote(forecast, ticker) : ticker;
  if (
    !forecast.available ||
    !isProbability(forecast.aboveProbability) ||
    !isProbability(forecast.belowProbability) ||
    Math.abs(forecast.aboveProbability + forecast.belowProbability - 1) > 0.000001 ||
    !isPositive(quote?.price) ||
    !isPositive(quote?.time) ||
    !isPositive(quote?.receivedAt) ||
    now - quote.time > 20_000 ||
    now - quote.receivedAt > 20_000 ||
    quote.time > now + 5000 ||
    quote.receivedAt > now + 5000
  ) {
    return unavailable('Waiting for a fresh, valid estimate for the saved target.');
  }
  const referencePrice = usesKalshi ? forecast.kalshi.referencePrice : ticker.price;
  const referenceAt = usesKalshi ? forecast.kalshi.referenceAt : ticker.time;
  const referenceSource = usesKalshi ? forecast.kalshi.referenceSource : 'coinbase';
  if (
    !isPositive(referencePrice) ||
    !isPositive(referenceAt) ||
    (usesKalshi &&
      (!['cf-brti', 'coinbase-proxy'].includes(referenceSource) ||
        referenceAt > now + 5000 ||
        now - referenceAt > (referenceSource === 'cf-brti' ? 5000 : 20_000)))
  ) {
    return unavailable('Waiting for a fresh reference price for this Kalshi estimate.');
  }
  const currentSide =
    referencePrice > fixedForecast.target
      ? 'above'
      : referencePrice < fixedForecast.target
        ? 'below'
        : 'at';
  const oppositeSide = currentSide === 'above' ? 'below' : currentSide === 'below' ? 'above' : null;
  const hasFixedDirection =
    fixedForecast.status === 'pending' && ['above', 'below'].includes(fixedForecast.direction);
  const fixedFailureSide = hasFixedDirection
    ? fixedForecast.direction === 'above'
      ? 'below'
      : 'above'
    : null;
  return {
    available: true,
    reason: null,
    referencePrice,
    referenceAt,
    referenceSource,
    referenceLabel:
      referenceSource === 'cf-brti'
        ? 'Current BRTI benchmark'
        : referenceSource === 'coinbase-proxy'
          ? 'Current Coinbase proxy'
          : 'Current Coinbase price',
    currentSide,
    oppositeSide,
    fixedFailureSide,
    fixedFailureProbability: hasFixedDirection ? forecast[`${fixedFailureSide}Probability`] : null,
    currentSideFlipProbability: oppositeSide ? forecast[`${oppositeSide}Probability`] : null,
    isAgainstFixedCall:
      hasFixedDirection && currentSide !== 'at' && currentSide !== fixedForecast.direction,
    fixedReason:
      fixedForecast.status === 'analyzing'
        ? 'The fixed prediction is still being observed.'
        : fixedForecast.status === 'withheld'
          ? 'No fixed prediction was issued for this window.'
          : !hasFixedDirection
            ? 'The fixed prediction has no directional edge.'
            : null,
    aboveProbability: forecast.aboveProbability,
    belowProbability: forecast.belowProbability,
  };
}

function getCompleteFlow(window) {
  if (
    !window?.available ||
    !Number.isFinite(window.buyBtc) ||
    !Number.isFinite(window.sellBtc) ||
    window.buyBtc < 0 ||
    window.sellBtc < 0
  ) {
    return null;
  }
  return { ...window, signedBtc: window.buyBtc - window.sellBtc };
}

/** Observable context, never a second probability or a publication veto. */
export function getReversalObservations({ stream, conditions, now } = {}) {
  const observations = [];
  const add = (code, text) => observations.push({ code, text });
  const impact = stream?.flow?.impact;
  const hasFreshFlow =
    isPositive(now) &&
    isPositive(impact?.asOf) &&
    now >= impact.asOf &&
    now - impact.asOf <= 5000 &&
    ['live', 'warming'].includes(stream?.status);
  if (hasFreshFlow) {
    const recent = getCompleteFlow(stream.flow.windows?.[15]);
    const minute = getCompleteFlow(stream.flow.windows?.[60]);
    if (recent && minute && minute.buyBtc >= recent.buyBtc && minute.sellBtc >= recent.sellBtc) {
      // Subtract the latest 15 seconds so the comparison does not count overlapping trades twice.
      const precedingNet = minute.signedBtc - recent.signedBtc;
      if (precedingNet * recent.signedBtc < 0) {
        add(
          'flow-turn',
          `Executed flow changed from net ${precedingNet > 0 ? 'buying' : 'selling'} in the preceding 45 seconds to net ${recent.signedBtc > 0 ? 'buying' : 'selling'} in the latest 15 seconds.`,
        );
      } else if (
        precedingNet * recent.signedBtc > 0 &&
        Math.abs(recent.signedBtc / 15) > Math.abs(precedingNet / 45)
      ) {
        add(
          'pressure-increasing',
          `Net ${recent.signedBtc > 0 ? 'buying' : 'selling'} per second increased in the latest 15 seconds compared with the preceding 45 seconds.`,
        );
      }
    }
    const sample = impact?.available && impact.samples?.at(-1);
    if (
      sample &&
      Number.isFinite(sample.startAt) &&
      sample.endAt - sample.startAt === 15_000 &&
      sample.endAt <= now &&
      now - sample.endAt <= 20_000 &&
      isPositive(sample.startPrice) &&
      isPositive(sample.endPrice) &&
      Number.isFinite(sample.buyBtc) &&
      Number.isFinite(sample.sellBtc) &&
      sample.buyBtc >= 0 &&
      sample.sellBtc >= 0
    ) {
      const signedBtc = sample.buyBtc - sample.sellBtc;
      if (signedBtc > 0 && sample.endPrice <= sample.startPrice) {
        add(
          'buying-without-rise',
          'Net buying did not lift the price in the latest verified 15-second interval.',
        );
      } else if (signedBtc < 0 && sample.endPrice >= sample.startPrice) {
        add(
          'selling-without-fall',
          'Net selling did not lower the price in the latest verified 15-second interval.',
        );
      }
    }
  }
  const liquidity = stream?.liquidity;
  if (
    liquidity?.available &&
    isPositive(liquidity.updatedAt) &&
    now >= liquidity.updatedAt &&
    now - liquidity.updatedAt <= 5000 &&
    liquidity.depthChange60?.available
  ) {
    for (const [side, label] of [
      ['bid', 'Buy'],
      ['ask', 'Sell'],
    ]) {
      const change = liquidity.depthChange60[`${side}Fraction`];
      if (Number.isFinite(change) && change <= -0.01 && change >= -1) {
        add(
          `${side}-depth-falling`,
          `${label}-side displayed depth within 0.1% of the midpoint decreased by ${(-change * 100).toFixed(1)}% over 60 seconds. Orders may be canceled.`,
        );
      }
    }
  }
  const features = conditions?.available && conditions.features;
  if (
    features &&
    Number.isFinite(features.latestCompletedAt) &&
    now >= features.latestCompletedAt &&
    now - features.latestCompletedAt <= 2 * MINUTE
  ) {
    const recentReturn = features.logReturn3Minutes;
    const acceleration = features.logReturnAcceleration3Minutes;
    const previousReturn = recentReturn - acceleration;
    if (
      Number.isFinite(recentReturn) &&
      Number.isFinite(acceleration) &&
      recentReturn * previousReturn < 0
    ) {
      add(
        'price-turn',
        `Completed three-minute price movement changed from ${previousReturn > 0 ? 'rising' : 'falling'} to ${recentReturn > 0 ? 'rising' : 'falling'}.`,
      );
    }
    if (
      Number.isFinite(features.shortLongVolatilityRatio) &&
      features.shortLongVolatilityRatio >= 1.5
    ) {
      add(
        'volatility-increasing',
        `Recent price volatility is ${features.shortLongVolatilityRatio.toFixed(1)} times its earlier level.`,
      );
    }
  }
  return observations;
}

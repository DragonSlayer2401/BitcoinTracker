export const DERIVATIVES_FORECAST_VERSION = 'derivatives-pressure-v1';

// These are conservative engineering assumptions, not fitted claims of predictive accuracy.
// Executed volume includes liquidations. Their separate feed changes context, never BTC totals.
export const DERIVATIVES_MODEL_PARAMETERS = Object.freeze({
  bucketSeconds: 15,
  minimumImpactSamples: 6,
  maximumImpactSamples: 15,
  shrinkagePriorSamples: 12,
  maximumInputAgeMs: 5000,
  maximumHistoryAgeMs: 240_000,
  pressureHalfLifeMinutes: 1,
  maximumDriftHorizonMinutes: 3,
  maximumDriftMinuteVolatilities: 0.35,
  maximumCombinedMinuteVolatilities: 0.85,
  maximumLargeTradeWeight: 0.25,
  maximumLiquidationWeight: 0.15,
  maximumAddedVarianceFraction: 0.5,
  windowWeights: Object.freeze({ 15: 0.5, 60: 0.3, 180: 0.2 }),
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const nonnegative = (value) => finite(value) && value >= 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const bounded = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const close = (left, right) => Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right));
const fresh = (time, now) =>
  timestamp(time) && time <= now && now - time <= DERIVATIVES_MODEL_PARAMETERS.maximumInputAgeMs;

function getEmptyDiagnostics(reason) {
  return {
    version: DERIVATIVES_FORECAST_VERSION,
    source: 'bybit-linear',
    symbol: 'BTCUSDT',
    available: false,
    applied: false,
    reason,
    asOf: null,
    baselineAboveProbability: null,
    aboveProbability: null,
    adjustmentPercentagePoints: 0,
    expectedLogReturn: 0,
    impactCoefficient: null,
    impactSampleCount: 0,
    reliability: 0,
    imbalance15: null,
    imbalance60: null,
    imbalance180: null,
    largeTradeImbalance: null,
    largeTradeShare: null,
    liquidationImbalance: null,
    relativeLiquidationVolume: null,
    priceResponse: null,
    liquidationStress: 0,
    basisLogReturn: null,
    openInterest: null,
    signedBtcPerMinute: null,
    futureVarianceMultiplier: 1,
  };
}

function getValidWindows(snapshot, now) {
  const result = [];
  for (const [secondsText, weight] of Object.entries(DERIVATIVES_MODEL_PARAMETERS.windowWeights)) {
    const seconds = Number(secondsText);
    const window = snapshot.windows?.[seconds];
    if (!window?.available) continue;
    if (
      snapshot.quality.completeSince > now - seconds * 1000 ||
      ![window.buyBtc, window.sellBtc, window.totalBtc].every(nonnegative) ||
      !finite(window.signedBtc) ||
      !finite(window.imbalance) ||
      Math.abs(window.imbalance) > 1 ||
      (window.logReturn !== null &&
        (!finite(window.logReturn) || Math.abs(window.logReturn) > 0.2)) ||
      (window.priceResponseAvailable === true && window.logReturn === null) ||
      !Number.isSafeInteger(window.tradeCount) ||
      window.tradeCount < 0 ||
      !finite(window.buyBtc + window.sellBtc) ||
      !close(window.totalBtc, window.buyBtc + window.sellBtc) ||
      !close(window.signedBtc, window.buyBtc - window.sellBtc) ||
      !close(window.imbalance, window.totalBtc > 0 ? window.signedBtc / window.totalBtc : 0) ||
      (window.tradeCount === 0) !== (window.totalBtc === 0)
    )
      return null;
    let largeTradeImbalance = null;
    let largeTradeShare = null;
    if (window.largeTradesAvailable === true) {
      if (
        !nonnegative(window.largeBuyBtc) ||
        !nonnegative(window.largeSellBtc) ||
        window.largeBuyBtc > window.buyBtc ||
        window.largeSellBtc > window.sellBtc ||
        !Number.isSafeInteger(window.largeTradeCount) ||
        window.largeTradeCount < 0 ||
        window.largeTradeCount > window.tradeCount
      )
        return null;
      const largeVolume = window.largeBuyBtc + window.largeSellBtc;
      if ((window.largeTradeCount === 0) !== (largeVolume === 0)) return null;
      largeTradeImbalance =
        largeVolume > 0 ? (window.largeBuyBtc - window.largeSellBtc) / largeVolume : 0;
      largeTradeShare = window.totalBtc > 0 ? largeVolume / window.totalBtc : 0;
    }
    result.push({ ...window, seconds, weight, largeTradeImbalance, largeTradeShare });
  }
  return result.length ? result : null;
}

function getImpactSamples(snapshot, now) {
  const impact = snapshot.impact;
  const parameters = DERIVATIVES_MODEL_PARAMETERS;
  const bucketMs = parameters.bucketSeconds * 1000;
  if (
    impact?.available !== true ||
    !fresh(impact.asOf, now) ||
    impact.completeSince !== snapshot.quality.completeSince ||
    impact.bucketSeconds !== parameters.bucketSeconds ||
    !Array.isArray(impact.samples) ||
    impact.samples.length < parameters.minimumImpactSamples ||
    impact.samples.length > parameters.maximumImpactSamples
  )
    return null;
  const samples = impact.samples;
  if (
    samples.some(
      (sample, index) =>
        !sample ||
        !timestamp(sample.startAt) ||
        !timestamp(sample.endAt) ||
        sample.endAt - sample.startAt !== bucketMs ||
        sample.startAt % bucketMs !== 0 ||
        sample.startAt < impact.completeSince ||
        sample.endAt > now ||
        now - sample.startAt > parameters.maximumHistoryAgeMs ||
        (index > 0 && sample.startAt < samples[index - 1].endAt) ||
        !positive(sample.startPrice) ||
        !positive(sample.endPrice) ||
        (sample.startPriceAt !== undefined &&
          (!timestamp(sample.startPriceAt) ||
            sample.startPriceAt > sample.startAt ||
            sample.startAt - sample.startPriceAt > bucketMs)) ||
        (sample.endPriceAt !== undefined &&
          (!timestamp(sample.endPriceAt) ||
            sample.endPriceAt > sample.endAt ||
            sample.endAt - sample.endPriceAt > bucketMs)) ||
        !nonnegative(sample.buyBtc) ||
        !nonnegative(sample.sellBtc) ||
        !finite(sample.buyBtc + sample.sellBtc) ||
        !Number.isSafeInteger(sample.tradeCount) ||
        sample.tradeCount < 0 ||
        (sample.tradeCount === 0) !== (sample.buyBtc + sample.sellBtc === 0) ||
        Math.abs(Math.log(sample.endPrice / sample.startPrice)) > 0.2,
    ) ||
    now - samples.at(-1).endAt > bucketMs + parameters.maximumInputAgeMs
  )
    return null;
  return samples;
}

function getLiquidationContext(snapshot, windows) {
  if (!snapshot.liquidations?.available) return null;
  // Use the longest complete shared window. Repeated messages do not count as extra evidence.
  for (const execution of [...windows].reverse()) {
    const liquidation = snapshot.liquidations.windows?.[execution.seconds];
    if (!liquidation?.available) continue;
    if (
      !nonnegative(liquidation.longBtc) ||
      !nonnegative(liquidation.shortBtc) ||
      !Number.isSafeInteger(liquidation.count) ||
      liquidation.count < 0 ||
      !finite(liquidation.longBtc + liquidation.shortBtc)
    )
      return null;
    const volume = liquidation.longBtc + liquidation.shortBtc;
    if ((liquidation.count === 0) !== (volume === 0)) return null;
    const relativeVolume = execution.totalBtc > 0 ? volume / execution.totalBtc : 0;
    if (!finite(relativeVolume)) return null;
    return {
      imbalance: volume > 0 ? (liquidation.shortBtc - liquidation.longBtc) / volume : 0,
      relativeVolume,
      stress: bounded(relativeVolume * 4, 0, 1),
    };
  }
  return null;
}

/** The directional effect decays rather than extrapolating a recent selloff for 15 minutes. */
export function getDerivativesLogShift(derivatives, minutes, minuteVolatility) {
  if (!derivatives?.applied || !positive(minutes) || !positive(minuteVolatility)) return 0;
  if (
    !finite(derivatives.impactCoefficient) ||
    !finite(derivatives.signedBtcPerMinute) ||
    !finite(derivatives.priceResponse) ||
    derivatives.impactCoefficient === 0 ||
    derivatives.signedBtcPerMinute === 0 ||
    derivatives.priceResponse === 0
  )
    return 0;
  const parameters = DERIVATIVES_MODEL_PARAMETERS;
  const decayRate = Math.log(2) / parameters.pressureHalfLifeMinutes;
  const effectiveMinutes = -Math.expm1(-decayRate * minutes) / decayRate;
  const maximumShift =
    parameters.maximumDriftMinuteVolatilities *
    minuteVolatility *
    Math.sqrt(Math.min(minutes, parameters.maximumDriftHorizonMinutes));
  return bounded(
    (derivatives.impactCoefficient ?? 0) *
      (derivatives.signedBtcPerMinute ?? 0) *
      (derivatives.priceResponse ?? 0) *
      effectiveMinutes,
    -maximumShift,
    maximumShift,
  );
}

/** Integrated decaying variance clock: historical and already observed prices have no exposure. */
export function getDerivativesVarianceTime(minutes) {
  if (!positive(minutes)) return 0;
  const decayRate = (2 * Math.log(2)) / DERIVATIVES_MODEL_PARAMETERS.pressureHalfLifeMinutes;
  return -Math.expm1(-decayRate * minutes) / decayRate;
}

/**
 * Fit contemporaneous 15s futures returns to signed BTC, shrink the slope toward zero, and
 * reduce the effect when current heavy selling/buying is being absorbed by the other side.
 * Large executions and liquidations reweight the same directional budget. They do not create
 * extra volume, guarantee causality, or veto an otherwise valid BRTI settlement forecast.
 */
export function getDerivativesForecast({ snapshot, now, minuteVolatility, horizonMinutes } = {}) {
  const fallback = getEmptyDiagnostics(
    'Futures feed unavailable; using the existing settlement calculation.',
  );
  if (
    !snapshot ||
    !timestamp(now) ||
    !positive(minuteVolatility) ||
    !positive(horizonMinutes) ||
    snapshot.version !== 'bybit-linear-flow-v1' ||
    snapshot.source !== 'bybit-linear' ||
    snapshot.symbol !== 'BTCUSDT' ||
    !['live', 'warming'].includes(snapshot.status) ||
    !fresh(snapshot.asOf, now) ||
    !fresh(snapshot.quality?.lastTradeAt, now) ||
    !fresh(snapshot.quality?.lastMessageAt, now) ||
    snapshot.quality?.subscribed !== true ||
    !timestamp(snapshot.quality?.completeSince) ||
    snapshot.quality.completeSince > now
  )
    return fallback;
  const windows = getValidWindows(snapshot, now);
  if (!windows)
    return {
      ...fallback,
      reason: 'Futures flow is warming or invalid; using the existing settlement calculation.',
    };
  const diagnostics = { ...fallback, available: true, asOf: snapshot.asOf };
  const totalWeight = windows.reduce((sum, window) => sum + window.weight, 0);
  const average = (getValue, selected = windows) => {
    const weight = selected.reduce((sum, window) => sum + window.weight, 0);
    return weight > 0
      ? selected.reduce((sum, window) => sum + (window.weight / weight) * getValue(window), 0)
      : null;
  };
  for (const window of windows) diagnostics[`imbalance${window.seconds}`] = window.imbalance;
  const largeWindows = windows.filter((window) => window.largeTradeShare !== null);
  diagnostics.largeTradeImbalance = average((window) => window.largeTradeImbalance, largeWindows);
  diagnostics.largeTradeShare = average((window) => window.largeTradeShare, largeWindows);
  const liquidation = getLiquidationContext(snapshot, windows);
  diagnostics.liquidationImbalance = liquidation?.imbalance ?? null;
  diagnostics.relativeLiquidationVolume = liquidation?.relativeVolume ?? null;
  diagnostics.liquidationStress = liquidation?.stress ?? 0;
  const ticker = snapshot.ticker;
  if (fresh(ticker?.time, now)) {
    if (positive(ticker.markPrice) && positive(ticker.indexPrice)) {
      const basis = Math.log(ticker.markPrice / ticker.indexPrice);
      if (finite(basis) && Math.abs(basis) <= 0.2) diagnostics.basisLogReturn = basis;
    }
    if (nonnegative(ticker.openInterest)) diagnostics.openInterest = ticker.openInterest;
  }
  const samples = getImpactSamples(snapshot, now);
  if (!samples)
    return {
      ...diagnostics,
      reason: 'Futures price-response fit is warming; using the existing settlement calculation.',
    };
  const sums = samples.reduce(
    (result, sample) => {
      const signed = sample.buyBtc - sample.sellBtc;
      const move = Math.log(sample.endPrice / sample.startPrice);
      return {
        signedSquares: result.signedSquares + signed ** 2,
        moveSquares: result.moveSquares + move ** 2,
        signedMove: result.signedMove + signed * move,
        volume: result.volume + sample.buyBtc + sample.sellBtc,
      };
    },
    { signedSquares: 0, moveSquares: 0, signedMove: 0, volume: 0 },
  );
  if (!Object.values(sums).every(finite) || sums.volume <= 0)
    return {
      ...diagnostics,
      reason: 'Futures impact inputs are invalid; using the existing settlement calculation.',
    };
  const fitStrength =
    sums.signedSquares > 0 && sums.moveSquares > 0 && sums.signedMove > 0
      ? bounded(
          (sums.signedMove / Math.sqrt(sums.signedSquares) / Math.sqrt(sums.moveSquares)) ** 2,
          0,
          1,
        )
      : 0;
  diagnostics.impactSampleCount = samples.length;
  diagnostics.reliability =
    (samples.length / (samples.length + DERIVATIVES_MODEL_PARAMETERS.shrinkagePriorSamples)) *
    fitStrength;
  const referenceVolumePerMinute =
    sums.volume / ((samples.length * DERIVATIVES_MODEL_PARAMETERS.bucketSeconds) / 60);
  const maximumCoefficient = minuteVolatility / referenceVolumePerMinute;
  diagnostics.impactCoefficient =
    fitStrength > 0
      ? Math.min(sums.signedMove / sums.signedSquares, maximumCoefficient) * diagnostics.reliability
      : 0;
  const totalRate = average((window) => (window.totalBtc * 60) / window.seconds);
  const executedRate = windows.reduce((sum, window) => {
    const largeWeight =
      DERIVATIVES_MODEL_PARAMETERS.maximumLargeTradeWeight * (window.largeTradeShare ?? 0);
    const weightedSigned =
      (1 - largeWeight) * window.signedBtc +
      largeWeight * (window.largeTradeImbalance ?? 0) * window.totalBtc;
    return sum + ((window.weight / totalWeight) * weightedSigned * 60) / window.seconds;
  }, 0);
  const liquidationWeight =
    DERIVATIVES_MODEL_PARAMETERS.maximumLiquidationWeight * diagnostics.liquidationStress;
  diagnostics.signedBtcPerMinute =
    (1 - liquidationWeight) * executedRate +
    liquidationWeight * (liquidation?.imbalance ?? 0) * totalRate;
  const responseWindows = windows.filter(
    (window) => finite(window.logReturn) && window.priceResponseAvailable !== false,
  );
  const recentReturnRate = average(
    (window) => (window.logReturn * 60) / window.seconds,
    responseWindows,
  );
  diagnostics.priceResponse =
    recentReturnRate === null
      ? null
      : bounded(
          (Math.sign(diagnostics.signedBtcPerMinute) * recentReturnRate) / (minuteVolatility * 0.5),
          0,
          1,
        );
  diagnostics.futureVarianceMultiplier =
    1 + DERIVATIVES_MODEL_PARAMETERS.maximumAddedVarianceFraction * diagnostics.liquidationStress;
  diagnostics.applied = true;
  diagnostics.expectedLogReturn = getDerivativesLogShift(
    diagnostics,
    horizonMinutes,
    minuteVolatility,
  );
  diagnostics.applied =
    diagnostics.expectedLogReturn !== 0 || diagnostics.futureVarianceMultiplier > 1;
  diagnostics.reason = diagnostics.applied
    ? null
    : 'Recent futures pressure has little measured price response; no directional correction applied.';
  if (
    ![
      diagnostics.impactCoefficient,
      diagnostics.signedBtcPerMinute,
      diagnostics.expectedLogReturn,
      diagnostics.futureVarianceMultiplier,
    ].every(finite)
  )
    return fallback;
  return diagnostics;
}

/** Compact diagnostics are persisted with a call; malformed numerical metadata is never restored. */
export function isDerivativesForecastMetadata(value) {
  if (
    !value ||
    value.version !== DERIVATIVES_FORECAST_VERSION ||
    value.source !== 'bybit-linear' ||
    value.symbol !== 'BTCUSDT' ||
    typeof value.available !== 'boolean' ||
    typeof value.applied !== 'boolean' ||
    (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length > 500)) ||
    (value.asOf !== null && !timestamp(value.asOf)) ||
    (value.available && value.asOf === null) ||
    (value.applied && !value.available) ||
    !Number.isSafeInteger(value.impactSampleCount) ||
    value.impactSampleCount < 0 ||
    value.impactSampleCount > DERIVATIVES_MODEL_PARAMETERS.maximumImpactSamples
  )
    return false;
  if (
    !value.available &&
    (value.asOf !== null ||
      value.impactSampleCount !== 0 ||
      value.reliability !== 0 ||
      value.liquidationStress !== 0 ||
      [
        'impactCoefficient',
        'imbalance15',
        'imbalance60',
        'imbalance180',
        'largeTradeImbalance',
        'largeTradeShare',
        'liquidationImbalance',
        'relativeLiquidationVolume',
        'priceResponse',
        'basisLogReturn',
        'openInterest',
        'signedBtcPerMinute',
      ].some((key) => value[key] !== null))
  )
    return false;
  for (const key of ['baselineAboveProbability', 'aboveProbability']) {
    if (value[key] !== null && (!finite(value[key]) || value[key] < 0 || value[key] > 1))
      return false;
  }
  for (const key of [
    'imbalance15',
    'imbalance60',
    'imbalance180',
    'largeTradeImbalance',
    'liquidationImbalance',
  ]) {
    if (value[key] !== null && (!finite(value[key]) || Math.abs(value[key]) > 1)) return false;
  }
  for (const key of ['reliability', 'liquidationStress']) {
    if (!finite(value[key]) || value[key] < 0 || value[key] > 1) return false;
  }
  for (const key of ['largeTradeShare', 'priceResponse']) {
    if (value[key] !== null && (!finite(value[key]) || value[key] < 0 || value[key] > 1))
      return false;
  }
  for (const key of ['impactCoefficient', 'relativeLiquidationVolume', 'openInterest']) {
    if (value[key] !== null && !nonnegative(value[key])) return false;
  }
  for (const key of ['basisLogReturn', 'signedBtcPerMinute']) {
    if (value[key] !== null && !finite(value[key])) return false;
  }
  if (
    (value.largeTradeImbalance === null) !== (value.largeTradeShare === null) ||
    (value.liquidationImbalance === null) !== (value.relativeLiquidationVolume === null) ||
    (value.liquidationImbalance === null && value.liquidationStress !== 0) ||
    (value.expectedLogReturn !== 0 &&
      (value.impactSampleCount < DERIVATIVES_MODEL_PARAMETERS.minimumImpactSamples ||
        !positive(value.impactCoefficient) ||
        !positive(value.priceResponse) ||
        !finite(value.signedBtcPerMinute)))
  )
    return false;
  return (
    finite(value.expectedLogReturn) &&
    Math.abs(value.expectedLogReturn) <= 0.2 &&
    (value.basisLogReturn === null || Math.abs(value.basisLogReturn) <= 0.2) &&
    finite(value.adjustmentPercentagePoints) &&
    finite(value.futureVarianceMultiplier) &&
    value.futureVarianceMultiplier >= 1 &&
    value.futureVarianceMultiplier <=
      1 + DERIVATIVES_MODEL_PARAMETERS.maximumAddedVarianceFraction &&
    (value.baselineAboveProbability === null ||
      value.aboveProbability === null ||
      close(
        value.adjustmentPercentagePoints,
        (value.aboveProbability - value.baselineAboveProbability) * 100,
      )) &&
    (value.applied ||
      (value.expectedLogReturn === 0 &&
        value.adjustmentPercentagePoints === 0 &&
        value.futureVarianceMultiplier === 1))
  );
}

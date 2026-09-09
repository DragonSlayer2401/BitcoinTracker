import jStat from 'jstat';
import { getForecast } from './forecast.utils';
import { getMarketConditions } from './marketConditions.utils';

export const PRESSURE_MODEL_VERSION = 'trade-pressure-log-return-v1';

// Engineering limits for an experimental, uncalibrated forecast. A fit to contemporaneous
// executions is not a validated estimate of future impact. Keep the baseline reproducible.
export const PRESSURE_MODEL_PARAMETERS = Object.freeze({
  bucketSeconds: 15,
  minimumImpactSamples: 6,
  maximumImpactSamples: 15,
  shrinkagePriorSamples: 12,
  maximumInputAgeMs: 5000,
  maximumHistoryAgeMs: 240_000,
  pressureHalfLifeMinutes: 1,
  maximumImpactMinuteVolatilities: 1,
  maximumDriftMinuteVolatilities: 0.75,
  maximumDriftHorizonMinutes: 3,
  minimumJumpElapsedMinutes: 0.25,
  currentJumpVolatilityWeight: 0.5,
  midpointWeight: 0.5,
  windowWeights: Object.freeze({ 15: 0.5, 60: 0.3, 180: 0.2 }),
});

const NORMAL_CENTRAL_80_QUANTILE = 1.2815515655446004;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositiveNumber = (value) => isFiniteNumber(value) && value > 0;
const isNonnegativeNumber = (value) => isFiniteNumber(value) && value >= 0;
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const getBoundedValue = (value, lower, upper) => Math.max(lower, Math.min(upper, value));
const getDirection = (probability) =>
  probability === null
    ? null
    : probability > 0.5
      ? 'above'
      : probability < 0.5
        ? 'below'
        : 'neutral';
const nearlyEqual = (left, right) => Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right));

function getFallback(baseline, reason, priceBased = null) {
  const forecast = { ...baseline, ...priceBased?.forecast };
  return {
    ...forecast,
    direction: getDirection(forecast.aboveProbability),
    modelVersion: PRESSURE_MODEL_VERSION,
    locationLogReturn: forecast.locationLogReturn ?? 0,
    pressure: {
      applied: false,
      reason,
      direction: null,
      strength: 0,
      modelKind: 'experimental',
      expectedLogReturn: 0,
      impactCoefficient: null,
      impactSampleCount: 0,
      reliability: 0,
      baselineAboveProbability: baseline.aboveProbability,
      unshiftedAboveProbability: forecast.aboveProbability,
      adjustmentPercentagePoints: 0,
      components: priceBased?.components ?? null,
      parameters: PRESSURE_MODEL_PARAMETERS,
    },
  };
}

function getValidatedImpact(stream, now) {
  const impact = stream?.flow?.impact;
  const quality = stream?.quality;
  if (
    impact?.available !== true ||
    !isTimestamp(impact.asOf) ||
    now < impact.asOf ||
    now - impact.asOf > PRESSURE_MODEL_PARAMETERS.maximumInputAgeMs ||
    !isTimestamp(impact.completeSince) ||
    !isTimestamp(impact.confirmedThrough) ||
    impact.confirmedThrough > now ||
    impact.confirmedThrough > impact.asOf ||
    now - impact.confirmedThrough > PRESSURE_MODEL_PARAMETERS.maximumInputAgeMs ||
    !isTimestamp(quality?.heartbeatAt) ||
    quality.heartbeatAt > now ||
    now - quality.heartbeatAt > PRESSURE_MODEL_PARAMETERS.maximumInputAgeMs ||
    quality.completeSince !== impact.completeSince ||
    quality.confirmedThrough !== impact.confirmedThrough ||
    !['live', 'warming'].includes(stream.status) ||
    impact.bucketSeconds !== PRESSURE_MODEL_PARAMETERS.bucketSeconds ||
    !Array.isArray(impact.samples) ||
    impact.samples.length < PRESSURE_MODEL_PARAMETERS.minimumImpactSamples ||
    impact.samples.length > PRESSURE_MODEL_PARAMETERS.maximumImpactSamples
  )
    return null;

  const bucketMs = impact.bucketSeconds * 1000;
  const samples = impact.samples;
  if (
    samples.some(
      (sample, index) =>
        !sample ||
        !isTimestamp(sample.startAt) ||
        !isTimestamp(sample.endAt) ||
        sample.endAt - sample.startAt !== bucketMs ||
        sample.startAt % bucketMs !== 0 ||
        sample.startAt < impact.completeSince ||
        now - sample.startAt > PRESSURE_MODEL_PARAMETERS.maximumHistoryAgeMs ||
        sample.endAt > impact.confirmedThrough ||
        (index > 0 && sample.startAt < samples[index - 1].endAt) ||
        !isPositiveNumber(sample.startPrice) ||
        !isPositiveNumber(sample.endPrice) ||
        !isNonnegativeNumber(sample.buyBtc) ||
        !isNonnegativeNumber(sample.sellBtc) ||
        !Number.isSafeInteger(sample.tradeCount) ||
        sample.tradeCount < 0 ||
        (sample.tradeCount === 0) !== (sample.buyBtc + sample.sellBtc === 0) ||
        Math.abs(Math.log(sample.endPrice / sample.startPrice)) > 0.2,
    ) ||
    now - samples.at(-1).endAt > bucketMs + PRESSURE_MODEL_PARAMETERS.maximumInputAgeMs
  )
    return null;
  return impact;
}

function getValidatedWindows(stream, impact, now) {
  const windows = [];
  for (const [secondsText, weight] of Object.entries(PRESSURE_MODEL_PARAMETERS.windowWeights)) {
    const seconds = Number(secondsText);
    const window = stream.flow.windows?.[seconds];
    if (!window?.available) continue;
    if (
      window.available !== true ||
      impact.completeSince > now - seconds * 1000 ||
      !Number.isSafeInteger(window.tradeCount) ||
      window.tradeCount < 0 ||
      !isNonnegativeNumber(window.buyBtc) ||
      !isNonnegativeNumber(window.sellBtc) ||
      !isNonnegativeNumber(window.totalBtc) ||
      !isFiniteNumber(window.signedBtc) ||
      !isFiniteNumber(window.imbalance) ||
      !Number.isFinite(window.buyBtc + window.sellBtc) ||
      !nearlyEqual(window.totalBtc, window.buyBtc + window.sellBtc) ||
      !nearlyEqual(window.signedBtc, window.buyBtc - window.sellBtc) ||
      !nearlyEqual(
        window.imbalance,
        window.totalBtc > 0 ? window.signedBtc / window.totalBtc : 0,
      ) ||
      (window.tradeCount === 0) !== (window.totalBtc === 0)
    )
      return null;
    windows.push({ ...window, seconds, weight });
  }
  return windows.length ? windows : null;
}

/**
 * Experimental execution-pressure location shift. Fit observed 15s log moves to signed BTC,
 * with zero intercept, then shrink/cap the fit and let the current pressure decay. No fixed
 * percentage bonus, repeated-vote interpretation, or claim of causal/predictive validation.
 * Missing optional flow removes the directional adjustment, while responsive price uncertainty
 * still accounts for recent ranges, smooth movement, jumps, and the bid/ask spread.
 */
export function getPressureForecast(input = {}) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const baseline = getForecast(safeInput);
  if (!baseline.available) return getFallback(baseline, baseline.reason);
  const { stream, candles, ticker, target, now } = safeInput;
  const horizonMinutes = baseline.horizonMinutes;
  const conditions = getMarketConditions({ candles, ticker, target, now, horizonMinutes });
  if (!conditions.available) return getFallback(baseline, conditions.reason);
  const features = conditions.features;
  const currentJumpVolatility =
    features.currentJumpLogReturn === null
      ? 0
      : (Math.abs(features.currentJumpLogReturn) *
          PRESSURE_MODEL_PARAMETERS.currentJumpVolatilityWeight) /
        Math.sqrt(
          Math.max(
            features.currentJumpElapsedMinutes,
            PRESSURE_MODEL_PARAMETERS.minimumJumpElapsedMinutes,
          ),
        );
  const minuteVolatility = Math.max(
    features.effectiveMinuteVolatility,
    features.ewmaMinuteVolatility,
    features.rangeVolatility5Minutes,
    currentJumpVolatility,
  );
  const midpointOffset = Math.log(features.midpoint / ticker.price);
  const midpointLocation = midpointOffset * PRESSURE_MODEL_PARAMETERS.midpointWeight;
  const halfLogSpread = Math.log(ticker.ask / ticker.bid) / 2;
  const volatility = Math.sqrt(
    minuteVolatility ** 2 * horizonMinutes + halfLogSpread ** 2 / 3 + midpointLocation ** 2,
  );
  const getAboveProbability = (location) =>
    getBoundedValue(
      1 - jStat.normal.cdf((Math.log(target / ticker.price) - location) / volatility, 0, 1),
      0.01,
      0.99,
    );
  const unshiftedAboveProbability = getAboveProbability(midpointLocation);
  const priceBased = {
    forecast: {
      aboveProbability: unshiftedAboveProbability,
      belowProbability: 1 - unshiftedAboveProbability,
      volatility,
      locationLogReturn: midpointLocation,
      lowerBound:
        ticker.price * Math.exp(midpointLocation - NORMAL_CENTRAL_80_QUANTILE * volatility),
      upperBound:
        ticker.price * Math.exp(midpointLocation + NORMAL_CENTRAL_80_QUANTILE * volatility),
    },
    components: { minuteVolatility, currentJumpVolatility, midpointLocation, halfLogSpread },
  };
  if (
    !Object.values(priceBased.forecast).every(Number.isFinite) ||
    ![priceBased.forecast.lowerBound, priceBased.forecast.upperBound, volatility].every(
      isPositiveNumber,
    )
  ) {
    return getFallback(baseline, 'The responsive price estimate cannot be calculated safely.');
  }
  const fallback = (reason) => getFallback(baseline, reason, priceBased);
  if (
    now < ticker.time ||
    now < ticker.receivedAt ||
    now - ticker.time > PRESSURE_MODEL_PARAMETERS.maximumInputAgeMs ||
    now - ticker.receivedAt > PRESSURE_MODEL_PARAMETERS.maximumInputAgeMs
  ) {
    return fallback(
      'Using price-based probabilities until the quote matches recent trade pressure.',
    );
  }
  const impact = getValidatedImpact(stream, now);
  const windows = impact ? getValidatedWindows(stream, impact, now) : null;
  if (!impact || !windows) {
    return fallback('Using price-based probabilities while verified pressure data builds.');
  }
  const samples = impact.samples.filter((sample) => sample.tradeCount > 0);
  if (samples.length < PRESSURE_MODEL_PARAMETERS.minimumImpactSamples) {
    return fallback('Using price-based probabilities until enough impact intervals exist.');
  }
  let sumSignedSquares = 0;
  let sumMoveSquares = 0;
  let sumSignedMove = 0;
  let sumVolume = 0;
  for (const sample of samples) {
    const signedBtc = sample.buyBtc - sample.sellBtc;
    const logMove = Math.log(sample.endPrice / sample.startPrice);
    sumSignedSquares += signedBtc ** 2;
    sumMoveSquares += logMove ** 2;
    sumSignedMove += signedBtc * logMove;
    sumVolume += sample.buyBtc + sample.sellBtc;
  }
  if (
    ![sumSignedSquares, sumMoveSquares, sumSignedMove, sumVolume].every(Number.isFinite) ||
    sumSignedSquares <= 0 ||
    sumMoveSquares <= 0 ||
    sumSignedMove <= 0
  ) {
    return fallback('Using price-based probabilities: recent trades show no positive impact fit.');
  }
  const fitStrength = getBoundedValue(
    (sumSignedMove / Math.sqrt(sumSignedSquares) / Math.sqrt(sumMoveSquares)) ** 2,
    0,
    1,
  );
  const sampleReliability =
    samples.length / (samples.length + PRESSURE_MODEL_PARAMETERS.shrinkagePriorSamples);
  const reliability = sampleReliability * fitStrength;
  const referenceVolumePerMinute = sumVolume / ((samples.length * impact.bucketSeconds) / 60);
  const maximumCoefficient =
    (minuteVolatility * PRESSURE_MODEL_PARAMETERS.maximumImpactMinuteVolatilities) /
    referenceVolumePerMinute;
  const rawCoefficient = sumSignedMove / sumSignedSquares;
  const impactCoefficient = Math.min(rawCoefficient, maximumCoefficient) * reliability;
  const totalWeight = windows.reduce((sum, window) => sum + window.weight, 0);
  const signedRate = windows.reduce(
    (sum, window) => sum + (window.weight / totalWeight) * window.signedBtc * (60 / window.seconds),
    0,
  );
  const imbalance = windows.reduce(
    (sum, window) => sum + (window.weight / totalWeight) * window.imbalance,
    0,
  );
  const decayRate = Math.log(2) / PRESSURE_MODEL_PARAMETERS.pressureHalfLifeMinutes;
  const effectivePressureMinutes = -Math.expm1(-decayRate * horizonMinutes) / decayRate;
  const maximumLogShift =
    PRESSURE_MODEL_PARAMETERS.maximumDriftMinuteVolatilities *
    minuteVolatility *
    Math.sqrt(Math.min(horizonMinutes, PRESSURE_MODEL_PARAMETERS.maximumDriftHorizonMinutes));
  const expectedLogReturn = getBoundedValue(
    impactCoefficient * signedRate * effectivePressureMinutes,
    -maximumLogShift,
    maximumLogShift,
  );
  const locationLogReturn = midpointLocation + expectedLogReturn;
  const aboveProbability = getAboveProbability(locationLogReturn);
  const lowerBound =
    ticker.price * Math.exp(locationLogReturn - NORMAL_CENTRAL_80_QUANTILE * volatility);
  const upperBound =
    ticker.price * Math.exp(locationLogReturn + NORMAL_CENTRAL_80_QUANTILE * volatility);
  if (![lowerBound, upperBound, volatility].every(isPositiveNumber)) {
    return fallback('Using price-based probabilities because the pressure range is invalid.');
  }
  return {
    ...baseline,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction: getDirection(aboveProbability),
    volatility,
    lowerBound,
    upperBound,
    modelVersion: PRESSURE_MODEL_VERSION,
    locationLogReturn,
    pressure: {
      applied: true,
      reason: null,
      direction: expectedLogReturn > 0 ? 'buy' : expectedLogReturn < 0 ? 'sell' : 'balanced',
      strength: Math.abs(imbalance) * reliability,
      modelKind: 'experimental',
      expectedLogReturn,
      impactCoefficient,
      impactSampleCount: samples.length,
      reliability,
      baselineAboveProbability: baseline.aboveProbability,
      unshiftedAboveProbability,
      adjustmentPercentagePoints: (aboveProbability - unshiftedAboveProbability) * 100,
      components: {
        fitStrength,
        sampleReliability,
        rawCoefficient,
        maximumCoefficient,
        referenceVolumePerMinute,
        signedBtcPerMinute: signedRate,
        weightedImbalance: imbalance,
        effectivePressureMinutes,
        maximumLogShift,
        minuteVolatility,
        currentJumpVolatility,
        midpointLocation,
        halfLogSpread,
        windows: windows.map(({ seconds, weight }) => ({ seconds, weight: weight / totalWeight })),
      },
      parameters: PRESSURE_MODEL_PARAMETERS,
    },
  };
}

/** Display the same decaying pressure path; fraction zero is the observed last trade. */
export function getPressureLocation(forecast, fraction) {
  if (!forecast?.available || !isFiniteNumber(fraction)) return 0;
  const boundedFraction = getBoundedValue(fraction, 0, 1);
  if (boundedFraction === 0) return 0;
  if (!forecast.pressure?.applied) return forecast.locationLogReturn ?? 0;
  if (boundedFraction === 1) return forecast.locationLogReturn;
  const { pressure, horizonMinutes } = forecast;
  const { components, parameters } = pressure;
  const minutes = horizonMinutes * boundedFraction;
  const decayRate = Math.log(2) / parameters.pressureHalfLifeMinutes;
  const effectiveMinutes = -Math.expm1(-decayRate * minutes) / decayRate;
  const maximumShift =
    parameters.maximumDriftMinuteVolatilities *
    components.minuteVolatility *
    Math.sqrt(Math.min(minutes, parameters.maximumDriftHorizonMinutes));
  return (
    components.midpointLocation +
    getBoundedValue(
      pressure.impactCoefficient * components.signedBtcPerMinute * effectiveMinutes,
      -maximumShift,
      maximumShift,
    )
  );
}

/** Keep spread and last-trade uncertainty at every positive horizon, including chart previews. */
export function getPressureVolatility(forecast, fraction) {
  if (!forecast?.available || !isFiniteNumber(fraction)) return 0;
  const boundedFraction = getBoundedValue(fraction, 0, 1);
  if (boundedFraction === 0) return 0;
  if (boundedFraction === 1) return forecast.volatility;
  const components = forecast.pressure?.components;
  if (
    !components ||
    !isPositiveNumber(forecast.horizonMinutes) ||
    !isPositiveNumber(components.minuteVolatility) ||
    !isFiniteNumber(components.midpointLocation) ||
    !isFiniteNumber(components.halfLogSpread)
  ) {
    return forecast.volatility * Math.sqrt(boundedFraction);
  }
  return Math.sqrt(
    components.minuteVolatility ** 2 * forecast.horizonMinutes * boundedFraction +
      components.halfLogSpread ** 2 / 3 +
      components.midpointLocation ** 2,
  );
}

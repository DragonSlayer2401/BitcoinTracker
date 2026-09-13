import jStat from 'jstat';
import { getPressureForecast, PRESSURE_MODEL_PARAMETERS } from '../pressureForecast.utils';
import { isKalshiContract, KALSHI_OUTCOME_DEFINITION } from './contract.utils';
import { getBenchmarkConditions, getBenchmarkReadings } from './benchmarkConditions.utils';
import {
  DERIVATIVES_MODEL_PARAMETERS,
  getDerivativesForecast,
  getDerivativesLogShift,
  getDerivativesVarianceTime,
} from '../derivativesForecast.utils';

export const KALSHI_MODEL_VERSION = 'kalshi-brti-average-v2';
export const KALSHI_DERIVATIVES_MODEL_VERSION = 'kalshi-brti-derivatives-v1';
export const KALSHI_MODEL_PARAMETERS = Object.freeze({
  sampleCount: 60,
  maximumBenchmarkAgeMs: 5000,
  maximumBasisComparisonAgeMs: 60_000,
  // An explicit engineering assumption until paired venue/index data can fit this uncertainty.
  // It is common to all proxy-dependent readings, so 60 samples cannot average it away.
  minimumProxyBasisLogDeviation: 0.0005,
});

const MINUTE = 60_000;
const NORMAL_CENTRAL_80_QUANTILE = 1.2815515655446004;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const bounded = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function getPressureShift(base, minutes) {
  const pressure = base.pressure;
  if (!pressure?.applied || minutes <= 0) return 0;
  const parameters = pressure.parameters ?? PRESSURE_MODEL_PARAMETERS;
  const decayRate = Math.log(2) / parameters.pressureHalfLifeMinutes;
  const effectiveMinutes = -Math.expm1(-decayRate * minutes) / decayRate;
  const maximumShift =
    parameters.maximumDriftMinuteVolatilities *
    pressure.components.minuteVolatility *
    Math.sqrt(Math.min(minutes, parameters.maximumDriftHorizonMinutes));
  return bounded(
    pressure.impactCoefficient * pressure.components.signedBtcPerMinute * effectiveMinutes,
    -maximumShift,
    maximumShift,
  );
}

/** Condition missing historical readings on genuine observations; never count interpolation as data. */
function getSampleDistribution(time, nodes, base, now) {
  const rightIndex = nodes.findIndex((node) => node.time >= time);
  const right = rightIndex === -1 ? null : nodes[rightIndex];
  const left = rightIndex === -1 ? nodes.at(-1) : nodes[rightIndex - 1];
  if (right?.time === time) {
    return {
      logMean: right.logPrice,
      pressureShift: 0,
      basisWeight: right.basisWeight,
      group: null,
      elapsed: 0,
    };
  }
  if (left && right) {
    const duration = (right.time - left.time) / MINUTE;
    const elapsed = (time - left.time) / MINUTE;
    const fraction = elapsed / duration;
    return {
      logMean: left.logPrice + fraction * (right.logPrice - left.logPrice),
      pressureShift: 0,
      basisWeight: left.basisWeight + fraction * (right.basisWeight - left.basisWeight),
      group: `bridge:${left.time}:${right.time}`,
      duration,
      elapsed,
    };
  }
  const anchor = left ?? right;
  const future = time > anchor.time;
  // Current execution pressure only acts after its observation time. Uncertainty starts at
  // the actual price timestamp, retaining the unobserved seconds before the current clock.
  const pressureShift = future ? getPressureShift(base, (time - now) / MINUTE) : 0;
  return {
    logMean: anchor.logPrice + pressureShift,
    pressureShift,
    basisWeight: anchor.basisWeight,
    group: `${future ? 'forward' : 'backward'}:${anchor.time}`,
    duration: null,
    elapsed: Math.abs(time - anchor.time) / MINUTE,
  };
}

function getLogCovariance(left, right, minuteVariance, basisVariance, addedMinuteVariance = 0) {
  let timeCovariance = 0;
  if (left.group && left.group === right.group) {
    timeCovariance = Math.min(left.elapsed, right.elapsed);
    if (left.duration) timeCovariance -= (left.elapsed * right.elapsed) / left.duration;
  }
  return (
    Math.max(0, timeCovariance) * minuteVariance +
    left.basisWeight * right.basisWeight * basisVariance +
    Math.min(left.futureVarianceTime ?? 0, right.futureVarianceTime ?? 0) * addedMinuteVariance
  );
}

function getAverageDistribution(
  distributions,
  minuteVariance,
  basisVariance,
  addedMinuteVariance = 0,
) {
  const expectedPrices = distributions.map((sample) =>
    Math.exp(
      sample.logMean +
        getLogCovariance(sample, sample, minuteVariance, basisVariance, addedMinuteVariance) / 2,
    ),
  );
  const count = distributions.length;
  const expectedAverage = jStat.sum(expectedPrices) / count;
  let varianceSum = 0;
  for (let left = 0; left < count; left += 1) {
    for (let right = 0; right < count; right += 1) {
      varianceSum +=
        expectedPrices[left] *
        expectedPrices[right] *
        Math.expm1(
          getLogCovariance(
            distributions[left],
            distributions[right],
            minuteVariance,
            basisVariance,
            addedMinuteVariance,
          ),
        );
    }
  }
  const averageVariance = varianceSum / count ** 2;
  const logVariance = Math.log1p(averageVariance / expectedAverage ** 2);
  return {
    expectedAverage,
    averageVariance,
    volatility: Math.sqrt(logVariance),
    logMedian: Math.log(expectedAverage) - logVariance / 2,
  };
}

function getAboveProbability(distribution, threshold) {
  return bounded(
    1 -
      jStat.normal.cdf(
        (Math.log(threshold) - distribution.logMedian) / distribution.volatility,
        0,
        1,
      ),
    0.01,
    0.99,
  );
}

/**
 * The predicted event is the cent-rounded arithmetic mean of BRTI at (end - 60s, end].
 * Correlated log-price moments give the mean's first two moments; a moment-matched lognormal
 * approximates its distribution. This is an uncalibrated model, not an exact law for Bitcoin.
 * Brownian bridges retain uncertainty for missing elapsed readings, while official readings
 * have zero observation variance. A proxy's shared basis error does not vanish near the end.
 */
export function getKalshiForecast(input = {}, pressureBase = null) {
  const { kalshiMarket: market, benchmark, now, ticker } = input;
  const hasDerivativesPolicy = input.derivatives !== undefined;
  const modelVersion = hasDerivativesPolicy
    ? KALSHI_DERIVATIVES_MODEL_VERSION
    : KALSHI_MODEL_VERSION;
  const horizonMinutes = (market?.expiresAt - now) / MINUTE;
  const base =
    pressureBase ?? getPressureForecast({ ...input, target: market?.target, horizonMinutes });
  const unavailable = (reason) => ({
    ...base,
    available: false,
    reason,
    aboveProbability: null,
    belowProbability: null,
    direction: null,
    lowerBound: null,
    upperBound: null,
    intervalAvailable: false,
    modelVersion,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  });
  if (!isKalshiContract(market)) return unavailable('Waiting for verified Kalshi contract rules.');
  if (!timestamp(now) || !positive(horizonMinutes) || horizonMinutes > 15) {
    return unavailable(
      'This Kalshi event must be open with between zero and 15 minutes remaining.',
    );
  }
  const readings = getBenchmarkReadings(benchmark, now);
  const benchmarkConditions = getBenchmarkConditions({
    benchmark,
    now,
    readings,
    target: market.target,
  });
  if (benchmarkConditions.isOutsideOperatingRange) return unavailable(benchmarkConditions.reason);
  if (!base.available && !benchmarkConditions.available) return unavailable(base.reason);
  const minuteVolatility = benchmarkConditions.available
    ? benchmarkConditions.features.effectiveMinuteVolatility
    : base.pressure?.components?.minuteVolatility;
  if (!positive(minuteVolatility)) {
    return unavailable('A responsive volatility estimate is required for the settlement average.');
  }

  const latest = readings.at(-1);
  const hasFreshBenchmark =
    latest && now - latest.time <= KALSHI_MODEL_PARAMETERS.maximumBenchmarkAgeMs;
  const referenceSource = hasFreshBenchmark ? 'cf-brti' : 'coinbase-proxy';
  const midpointLocation = base.pressure?.components?.midpointLocation ?? 0;
  const proxyPrice = positive(ticker?.price) ? ticker.price * Math.exp(midpointLocation) : null;
  const referencePrice = hasFreshBenchmark ? latest.price : proxyPrice;
  const referenceAt = hasFreshBenchmark ? latest.time : now;
  const referenceReceivedAt = hasFreshBenchmark
    ? timestamp(benchmark?.receivedAt)
      ? benchmark.receivedAt
      : referenceAt
    : ticker.receivedAt;
  const recentBasisDifference =
    positive(proxyPrice) &&
    latest &&
    now - latest.time <= KALSHI_MODEL_PARAMETERS.maximumBasisComparisonAgeMs
      ? Math.abs(Math.log(proxyPrice / latest.price))
      : 0;
  const basisLogDeviation = hasFreshBenchmark
    ? 0
    : Math.max(
        KALSHI_MODEL_PARAMETERS.minimumProxyBasisLogDeviation,
        recentBasisDifference,
        Math.abs(base.pressure?.components?.halfLogSpread ?? 0),
      );
  const sampleTimes = Array.from(
    { length: KALSHI_MODEL_PARAMETERS.sampleCount },
    (_, index) => market.expiresAt - (59 - index) * 1000,
  );
  const firstSampleAt = sampleTimes[0];
  // Retain the nearest preceding benchmark as a bridge endpoint, without counting it as a slot.
  const preceding = readings.findLast((sample) => sample.time < firstSampleAt);
  const usefulReadings = readings.filter((sample) => sample.time >= firstSampleAt);
  if (preceding) usefulReadings.unshift(preceding);
  const nodes = usefulReadings.map((sample) => ({
    ...sample,
    logPrice: Math.log(sample.price),
    basisWeight: 0,
  }));
  if (!hasFreshBenchmark) {
    // A missing BRTI value is not replaced in the observed-readings collection.
    nodes.push({ time: now, logPrice: Math.log(proxyPrice), basisWeight: 1 });
  }
  const observedPrices = new Map(usefulReadings.map((sample) => [sample.time, sample.price]));
  const observedSampleCount = sampleTimes.filter((time) => observedPrices.has(time)).length;
  const missingElapsedSampleCount = sampleTimes.filter(
    (time) => time <= now && !observedPrices.has(time),
  ).length;
  const futureSampleCount = sampleTimes.filter((time) => time > now).length;
  // Coinbase's execution fit remains an optional input. Its maximum effect is expressed in
  // the chosen index volatility, so a noisier venue cannot overwhelm quiet benchmark data.
  const modelBase = {
    ...base,
    pressure: {
      ...base.pressure,
      reason:
        benchmarkConditions.available && !base.available
          ? 'Using BRTI price dynamics; Coinbase execution pressure is unavailable.'
          : base.pressure?.reason,
      components: { ...base.pressure?.components, minuteVolatility },
    },
  };
  const baselineDistributions = sampleTimes.map((time) =>
    getSampleDistribution(time, nodes, modelBase, now),
  );
  const minuteVariance = minuteVolatility ** 2;
  const basisVariance = basisLogDeviation ** 2;
  const derivatives = hasDerivativesPolicy
    ? getDerivativesForecast({
        snapshot: input.derivatives,
        now,
        minuteVolatility,
        horizonMinutes,
      })
    : null;
  const getIncrementalShift = (minutes, pressureShift) => {
    if (!derivatives?.applied || minutes <= 0) return 0;
    const maximumCombinedShift =
      DERIVATIVES_MODEL_PARAMETERS.maximumCombinedMinuteVolatilities *
      minuteVolatility *
      Math.sqrt(Math.min(minutes, DERIVATIVES_MODEL_PARAMETERS.maximumDriftHorizonMinutes));
    return (
      bounded(
        pressureShift + getDerivativesLogShift(derivatives, minutes, minuteVolatility),
        -maximumCombinedShift,
        maximumCombinedShift,
      ) - pressureShift
    );
  };
  // Only future samples receive futures pressure/risk. Official observations and missing
  // elapsed Brownian bridges retain exactly their original values and covariance.
  const distributions = derivatives?.applied
    ? baselineDistributions.map((sample, index) => {
        const minutes = (sampleTimes[index] - now) / MINUTE;
        return minutes > 0
          ? {
              ...sample,
              logMean: sample.logMean + getIncrementalShift(minutes, sample.pressureShift),
              futureVarianceTime: getDerivativesVarianceTime(minutes),
            }
          : sample;
      })
    : baselineDistributions;
  const addedMinuteVariance = derivatives?.applied
    ? minuteVariance * (derivatives.futureVarianceMultiplier - 1)
    : 0;
  const baselineDistribution = getAverageDistribution(
    baselineDistributions,
    minuteVariance,
    basisVariance,
  );
  const distribution = derivatives?.applied
    ? getAverageDistribution(distributions, minuteVariance, basisVariance, addedMinuteVariance)
    : baselineDistribution;
  const { expectedAverage, averageVariance, volatility, logMedian } = distribution;
  if (!positive(expectedAverage) || !positive(volatility)) {
    return unavailable('The remaining settlement uncertainty cannot be calculated safely.');
  }
  // YES includes equality after the settlement value is rounded to cents.
  const threshold = market.target - 0.005;
  const aboveProbability = getAboveProbability(distribution, threshold);
  const baselineAboveProbability = getAboveProbability(baselineDistribution, threshold);
  const unshiftedAboveProbability = base.pressure?.applied
    ? getAboveProbability(
        getAverageDistribution(
          baselineDistributions.map((sample) => ({
            ...sample,
            logMean: sample.logMean - sample.pressureShift,
          })),
          minuteVariance,
          basisVariance,
        ),
        threshold,
      )
    : baselineAboveProbability;
  const lowerBound = Math.exp(logMedian - NORMAL_CENTRAL_80_QUANTILE * volatility);
  const upperBound = Math.exp(logMedian + NORMAL_CENTRAL_80_QUANTILE * volatility);
  if (![aboveProbability, lowerBound, upperBound].every(positive)) {
    return unavailable('The settlement estimate cannot be calculated safely.');
  }
  return {
    ...base,
    available: true,
    reason: null,
    modelVersion,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    target: market.target,
    expiresAt: market.expiresAt,
    horizonMinutes,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction: aboveProbability > 0.5 ? 'above' : aboveProbability < 0.5 ? 'below' : 'neutral',
    volatility,
    locationLogReturn: logMedian - Math.log(referencePrice),
    sampleCount: benchmarkConditions.available
      ? benchmarkConditions.features.completedCandleCount - 1
      : base.sampleCount,
    // Keep settlement bounds separate from generic spot intervals; the BRTI chart reads them below.
    lowerBound: null,
    upperBound: null,
    intervalAvailable: false,
    intervalReason:
      'This forecast estimates the final settlement average, not a future spot-price path.',
    pressure: {
      ...modelBase.pressure,
      expectedLogReturn: getPressureShift(modelBase, horizonMinutes),
      baselineAboveProbability: unshiftedAboveProbability,
      unshiftedAboveProbability,
      adjustmentPercentagePoints: (baselineAboveProbability - unshiftedAboveProbability) * 100,
    },
    ...(derivatives
      ? {
          derivatives: {
            ...derivatives,
            expectedLogReturn: getIncrementalShift(
              horizonMinutes,
              getPressureShift(modelBase, horizonMinutes),
            ),
            baselineAboveProbability,
            aboveProbability,
            adjustmentPercentagePoints: (aboveProbability - baselineAboveProbability) * 100,
          },
        }
      : {}),
    kalshi: {
      marketTicker: market.ticker,
      comparison: market.comparison,
      roundDigits: market.roundDigits,
      referenceSource,
      referencePrice,
      referenceAt,
      referenceReceivedAt,
      priceDynamicsSource: benchmarkConditions.available ? 'cf-brti-history' : 'coinbase-candles',
      volatilitySource: benchmarkConditions.available ? 'cf-brti' : 'coinbase-proxy',
      minuteVolatility,
      benchmarkConditions,
      modelKind: 'experimental',
      approximate: true,
      observedSampleCount,
      missingElapsedSampleCount,
      futureSampleCount,
      basisLogDeviation,
      basisAssumption: hasFreshBenchmark
        ? null
        : 'Unfitted shared venue-to-index uncertainty floor.',
      expectedSettlementAverage: expectedAverage,
      settlementStandardDeviation: Math.sqrt(averageVariance),
      settlementLowerBound: lowerBound,
      settlementUpperBound: upperBound,
      requiredFutureAverage:
        missingElapsedSampleCount === 0 && futureSampleCount > 0
          ? (sampleTimes.length * threshold -
              jStat.sum(
                [...observedPrices.entries()]
                  .filter(([time]) => sampleTimes.includes(time))
                  .map(([, price]) => price),
              )) /
            futureSampleCount
          : null,
      warning: hasFreshBenchmark
        ? missingElapsedSampleCount > 0
          ? 'Some elapsed benchmark readings are missing and remain uncertain.'
          : 'Benchmark-anchored model estimate; predictive accuracy has not been established.'
        : 'Coinbase proxy estimate: the live settlement benchmark is unavailable.',
      parameters: KALSHI_MODEL_PARAMETERS,
    },
  };
}

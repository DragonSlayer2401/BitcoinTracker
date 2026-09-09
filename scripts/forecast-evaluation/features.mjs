import jStat from 'jstat';

export const FEATURE_NAMES = [
  'targetDistance',
  'remainingFraction',
  'distanceByHorizon',
  'return1',
  'return3',
  'return5',
  'return15',
  'acceleration3',
  'volumeRatio5',
  'range5',
  'closePosition',
  'return3ByHorizon',
];
export const FEATURE_GROUPS = {
  'distance-only': [0, 1, 2],
  'plus-returns': [0, 1, 2, 3, 4, 5, 6, 11],
  'plus-acceleration': [0, 1, 2, 3, 4, 5, 6, 7, 11],
  'plus-volume': [0, 1, 2, 3, 4, 5, 6, 7, 8, 11],
  'plus-range-position': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const bounded = (value, limit = 8) => Math.max(-limit, Math.min(limit, value));

export function summarizeHistory(history) {
  const returns = history
    .slice(1)
    .map((candle, index) => Math.log(candle.close / history[index].close));
  const variance = jStat.variance(returns, true);
  const weights = returns.map((_, index) => 2 ** (-(returns.length - 1 - index) / 30));
  const weightSum = jStat.sum(weights);
  const weightedMean = jStat.sum(returns.map((value, index) => value * weights[index])) / weightSum;
  const ewmaVariance =
    jStat.sum(returns.map((value, index) => weights[index] * (value - weightedMean) ** 2)) /
    (weightSum - jStat.sumsqrd(weights) / weightSum);
  const sigma = Math.sqrt(variance);
  const last = history.at(-1);
  const returnFor = (minutes) => Math.log(last.close / history.at(-1 - minutes).close);
  return {
    sigma,
    variances: {
      normal: variance,
      rms: jStat.mean(returns.map((value) => value ** 2)),
      range:
        jStat.mean(history.map((candle) => Math.log(candle.high / candle.low) ** 2)) /
        (4 * Math.log(2)),
      ewma: ewmaVariance,
    },
    price: last.close,
    returns: [1, 3, 5, 15].map((minutes) =>
      bounded(returnFor(minutes) / (sigma * Math.sqrt(minutes))),
    ),
    acceleration: bounded(
      (returnFor(3) - Math.log(history.at(-4).close / history.at(-7).close)) /
        (sigma * Math.sqrt(6)),
    ),
    volumeRatio: bounded(
      Math.log(
        (jStat.mean(history.slice(-5).map((candle) => candle.volume)) + 1e-9) /
          (jStat.mean(history.slice(-65, -5).map((candle) => candle.volume)) + 1e-9),
      ),
      5,
    ),
    range: bounded(
      (Math.max(...history.slice(-5).map((candle) => candle.high)) -
        Math.min(...history.slice(-5).map((candle) => candle.low))) /
        (last.close * sigma * Math.sqrt(5)),
    ),
    closePosition:
      last.high === last.low ? 0 : (last.close - last.low) / (last.high - last.low) - 0.5,
    trend: returnFor(15) / (sigma * Math.sqrt(15)),
  };
}

export function getDirectionalFeatures(summary, target, remainingMinutes) {
  const distance = bounded(
    (Math.log(summary.price) - Math.log(target)) / (summary.sigma * Math.sqrt(remainingMinutes)),
  );
  const fraction = remainingMinutes / 15;
  return [
    distance,
    fraction,
    distance * fraction,
    ...summary.returns,
    summary.acceleration,
    summary.volumeRatio,
    summary.range,
    summary.closePosition,
    summary.returns[1] * fraction,
  ];
}

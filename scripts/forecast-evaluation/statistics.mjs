import jStat from 'jstat';

export const getBoundedProbability = (value) => Math.max(0.01, Math.min(0.99, value));
export const sigmoid = (value) =>
  value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
export const logit = (value) =>
  Math.log(
    Math.max(1e-6, Math.min(1 - 1e-6, value)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, value))),
  );

// Full-batch penalized logistic regression. Normalization is fitted only from
// supplied training rows; callers pass a disjoint set for calibration.
export function fitLogistic(rows, indexes, { penalty = 0.001, maximumIterations = 30 } = {}) {
  if (!rows.length || !indexes.length)
    throw new Error('Logistic fitting requires training data and features.');
  const means = indexes.map((index) => jStat.mean(rows.map((row) => row.features[index])));
  const scales = indexes.map(
    (index, column) =>
      Math.sqrt(jStat.mean(rows.map((row) => (row.features[index] - means[column]) ** 2))) || 1,
  );
  const matrix = rows.map((row) => [
    1,
    ...indexes.map((index, column) => (row.features[index] - means[column]) / scales[column]),
  ]);
  const dimension = indexes.length + 1;
  let coefficients = Array(dimension).fill(0);
  const loss = (values) =>
    jStat.mean(
      matrix.map((features, index) => {
        const score = features.reduce((sum, value, column) => sum + value * values[column], 0);
        return (
          Math.max(score, 0) - rows[index].outcome * score + Math.log1p(Math.exp(-Math.abs(score)))
        );
      }),
    ) +
    (penalty * jStat.sumsqrd(values.slice(1))) / 2;
  let previousLoss = loss(coefficients);
  let iterations = 0;
  for (; iterations < maximumIterations; iterations++) {
    const gradient = Array(dimension).fill(0);
    const hessian = Array.from({ length: dimension }, () => Array(dimension).fill(0));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const features = matrix[rowIndex];
      let score = 0;
      for (let column = 0; column < dimension; column++)
        score += features[column] * coefficients[column];
      const probability = sigmoid(score);
      const residual = probability - rows[rowIndex].outcome;
      const weight = Math.max(1e-8, probability * (1 - probability));
      for (let first = 0; first < dimension; first++) {
        gradient[first] += features[first] * residual;
        for (let second = 0; second <= first; second++)
          hessian[first][second] += features[first] * features[second] * weight;
      }
    }
    for (let first = 0; first < dimension; first++) {
      gradient[first] = gradient[first] / rows.length + (first ? penalty * coefficients[first] : 0);
      for (let second = 0; second <= first; second++)
        hessian[second][first] = hessian[first][second] /= rows.length;
      hessian[first][first] += first ? penalty : 1e-8;
    }
    const step = jStat.lstsq(hessian, gradient);
    if (!step.every(Number.isFinite))
      throw new Error('Logistic optimizer produced a non-finite update.');
    let rate = 1;
    let next = coefficients.map((value, index) => value - step[index]);
    let nextLoss = loss(next);
    while (nextLoss > previousLoss && rate > 1 / 256) {
      rate /= 2;
      next = coefficients.map((value, index) => value - rate * step[index]);
      nextLoss = loss(next);
    }
    if (nextLoss > previousLoss) break;
    coefficients = next;
    if (Math.abs(previousLoss - nextLoss) < 1e-9) {
      previousLoss = nextLoss;
      break;
    }
    previousLoss = nextLoss;
  }
  return {
    indexes,
    means,
    scales,
    coefficients,
    penalty,
    iterations,
    trainingRows: rows.length,
    trainingLoss: previousLoss,
  };
}

export function predictLogistic(model, features) {
  const score = model.indexes.reduce(
    (sum, index, column) =>
      sum +
      (model.coefficients[column + 1] * (features[index] - model.means[column])) /
        model.scales[column],
    model.coefficients[0],
  );
  return getBoundedProbability(sigmoid(score));
}

export function scoreProbabilities(rows, threshold = 0.55) {
  const bins = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    count: 0,
    probabilitySum: 0,
    outcomeSum: 0,
  }));
  let squaredError = 0;
  let logLoss = 0;
  let calls = 0;
  let correct = 0;
  let sameTimestampCorrect = 0;
  const intervals = new Map();
  for (const row of rows) {
    if (
      !Number.isFinite(row.probability) ||
      row.probability < 0 ||
      row.probability > 1 ||
      ![0, 1].includes(row.outcome)
    )
      throw new Error('Invalid probability scoring input.');
    const probability = row.probability;
    squaredError += (probability - row.outcome) ** 2;
    const safe = Math.max(1e-6, Math.min(1 - 1e-6, probability));
    logLoss -= row.outcome * Math.log(safe) + (1 - row.outcome) * Math.log(1 - safe);
    if (Math.max(probability, 1 - probability) >= threshold) {
      calls++;
      correct += Number(Number(probability > 0.5) === row.outcome);
      sameTimestampCorrect +=
        row.currentSide === 0.5 ? 0.5 : Number(row.currentSide === row.outcome);
    }
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count++;
    bin.probabilitySum += probability;
    bin.outcomeSum += row.outcome;
    if (typeof row.intervalCovered === 'boolean')
      intervals.set(row.captureKey, row.intervalCovered);
  }
  const calibrationBins = bins.map(({ probabilitySum, outcomeSum, ...bin }) => ({
    ...bin,
    meanProbability: bin.count ? probabilitySum / bin.count : null,
    observedAboveRate: bin.count ? outcomeSum / bin.count : null,
  }));
  return {
    examples: rows.length,
    windows: new Set(rows.map((row) => row.windowStart)).size,
    brier: rows.length ? squaredError / rows.length : null,
    logLoss: rows.length ? logLoss / rows.length : null,
    calibrationBins,
    expectedCalibrationError: rows.length
      ? calibrationBins.reduce(
          (sum, bin) =>
            sum + bin.count * Math.abs((bin.meanProbability ?? 0) - (bin.observedAboveRate ?? 0)),
          0,
        ) / rows.length
      : null,
    threshold,
    calls,
    callCoverage: rows.length ? calls / rows.length : null,
    noCallRate: rows.length ? 1 - calls / rows.length : null,
    callAccuracy: calls ? correct / calls : null,
    currentSideAccuracyOnSameCalls: calls ? sameTimestampCorrect / calls : null,
    intervalExamples: intervals.size,
    central80IntervalCoverage: intervals.size
      ? jStat.mean([...intervals.values()].map(Number))
      : null,
  };
}

import {
  CHALLENGER_CALIBRATION_VERSION,
  CAP_AWARE_CHALLENGER_CALIBRATION_VERSION,
  LEGACY_CHALLENGER_CALIBRATION_VERSION,
  applyCheckpointCalibration,
  fitCheckpointCalibration,
  isCheckpointCalibration,
} from '../utils/learning/challengerCheckpoint.utils';
import { getBoundedProbability, logit, sigmoid } from '../utils/learning/statistics.utils';
import { trainChallengerCandidate } from '../utils/learning/challengerTraining.utils';
import { afterWindow, windowSet } from './fixtures/challengerFixtures';

function getPublishedProbability(row, offset, maximumBaselineAdjustment = null) {
  const calibrated = applyCheckpointCalibration(row.probability, 6, {
    checkpoints: [{ checkpointMinutes: 6, status: 'fitted', offset }],
  });
  if (maximumBaselineAdjustment === null) return calibrated;
  const baseline = row.learningFeatures.baselineAboveProbability;
  return getBoundedProbability(
    baseline +
      Math.max(
        -maximumBaselineAdjustment,
        Math.min(maximumBaselineAdjustment, calibrated - baseline),
      ),
  );
}

function loss(rows, offset, maximumBaselineAdjustment = null) {
  return rows.reduce(
    (total, row) => {
      const predicted = getPublishedProbability(row, offset, maximumBaselineAdjustment);
      return total - row.outcome * Math.log(predicted) - (1 - row.outcome) * Math.log1p(-predicted);
    },
    10 * offset ** 2,
  );
}

function fit(rows, maximumBaselineAdjustment = null) {
  return fitCheckpointCalibration(rows, { maximumBaselineAdjustment }).find(
    (entry) => entry.checkpointMinutes === 6,
  );
}

test('calibration does not worsen uncapped rows to chase improvements that the total prediction cap forbids', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    horizonMinutes: 6,
    probability: index < 12 ? 0.55 : 0.45,
    outcome: index < 12 ? 1 : 0,
    learningFeatures: { baselineAboveProbability: 0.5 },
  }));
  const oldUncappedOffset = fit(rows).offset;
  expect(oldUncappedOffset).toBeGreaterThan(0);
  expect(loss(rows, oldUncappedOffset, 0.05)).toBeGreaterThan(loss(rows, 0, 0.05));
  const corrected = fit(rows, 0.05);
  expect(corrected).toMatchObject({ status: 'fitted', samples: 20, offset: 0 });
  expect(rows.map((row) => getPublishedProbability(row, corrected.offset, 0.05))).toEqual(
    rows.map((row) => row.probability),
  );
});

test.each([null, 0.05])(
  'calibration finds the best published penalized loss across clipping boundaries (%s)',
  (maximumBaselineAdjustment) => {
    const rows = Array.from({ length: 40 }, (_, index) => {
      const baseline = [0.02, 0.25, 0.5, 0.75, 0.98][index % 5];
      return {
        horizonMinutes: 6,
        probability: getBoundedProbability(baseline + [-0.05, 0, 0.05][index % 3]),
        outcome: Number(index % 7 >= 2),
        learningFeatures: { baselineAboveProbability: baseline },
      };
    });
    const result = fit(rows, maximumBaselineAdjustment);
    const fittedLoss = loss(rows, result.offset, maximumBaselineAdjustment);
    expect(Math.abs(result.offset)).toBeLessThanOrEqual(1);
    expect(fittedLoss).toBeLessThanOrEqual(loss(rows, 0, maximumBaselineAdjustment) + 1e-10);
    // An independent dense grid checks the global choice, including non-smooth cap boundaries.
    for (let index = 0; index <= 2000; index++)
      expect(fittedLoss).toBeLessThanOrEqual(
        loss(rows, -1 + index / 1000, maximumBaselineAdjustment) + 1e-8,
      );
    const expectedMean =
      rows.reduce(
        (sum, row) => sum + getPublishedProbability(row, result.offset, maximumBaselineAdjustment),
        0,
      ) / rows.length;
    const reliabilityMean =
      result.reliability.reduce(
        (sum, bin) => sum + bin.samples * (bin.predictedProbability ?? 0),
        0,
      ) / rows.length;
    expect(reliabilityMean).toBeCloseTo(expectedMean, 12);
  },
);

test('new fitting identifies its corrected calibration while old saved offsets keep exact replay', () => {
  const model = trainChallengerCandidate(windowSet(80), [], {
    kind: 'reversal',
    now: afterWindow(79),
  }).artifact;
  expect(model.calibration.version).toBe(CHALLENGER_CALIBRATION_VERSION);
  const legacy = {
    ...model.calibration,
    version: LEGACY_CHALLENGER_CALIBRATION_VERSION,
    checkpoints: model.calibration.checkpoints.map((entry) => ({
      ...entry,
      status: 'fitted',
      offset: 0.2,
    })),
  };
  expect(isCheckpointCalibration(legacy, model.trainedAt)).toBe(true);
  const probability = 0.6;
  const original = getBoundedProbability(
    probability + Math.max(-0.05, Math.min(0.05, sigmoid(logit(probability) + 0.2) - probability)),
  );
  expect(applyCheckpointCalibration(probability, 6, legacy)).toBe(original);
});

test('too little calibration evidence stays identity and invalid fit inputs are rejected', () => {
  const rows = Array.from({ length: 19 }, (_, index) => ({
    horizonMinutes: 6,
    probability: 0.7,
    outcome: index % 2,
  }));
  expect(fit(rows)).toMatchObject({ status: 'identity', offset: 0, samples: 19 });
  expect(() => fit(rows, 0.05)).toThrow(/baseline/);
  expect(() => fit([{ ...rows[0], probability: NaN }])).toThrow(/probabilities/);
  expect(() => fit([{ ...rows[0], probability: -0.001 }])).toThrow(/probabilities/);
  expect(() => fit([{ ...rows[0], probability: 1.001 }])).toThrow(/probabilities/);
});

test('valid structural tail probabilities fit the exact bounded publication loss', () => {
  const raw = [0, 0.005948280444444444, 0.15, 0.45, 0.65, 0.85, 0.9945315290277779, 1];
  const rows = Array.from({ length: 40 }, (_, index) => ({
    horizonMinutes: 6,
    probability: raw[index % raw.length],
    outcome: Number(index % 5 !== 0),
  }));
  const result = fit(rows);
  expect(result.status).toBe('fitted');
  const fittedLoss = loss(rows, result.offset);
  for (let index = 0; index <= 2000; index++)
    expect(fittedLoss).toBeLessThanOrEqual(loss(rows, -1 + index / 1000) + 1e-8);
  const published = rows.map((row) => ({
    ...row,
    probability: getPublishedProbability(row, result.offset),
  }));
  expect(published.every((row) => row.probability >= 0.01 && row.probability <= 0.99)).toBe(true);
  for (const bin of result.reliability) {
    const matching = published.filter(
      (row) => row.probability >= bin.lower && (row.probability < bin.upper || bin.upper === 1),
    );
    expect(bin.samples).toBe(matching.length);
    if (matching.length)
      expect(bin.predictedProbability).toBeCloseTo(
        matching.reduce((sum, row) => sum + row.probability, 0) / matching.length,
        12,
      );
  }
});

test('identity reliability retains raw zero, one, and extreme structural values', () => {
  const rows = [0, 0.005, 0.995, 1].map((probability, index) => ({
    horizonMinutes: 6,
    probability,
    outcome: index % 2,
  }));
  const result = fit(rows);
  expect(result.status).toBe('identity');
  expect(result.reliability[0]).toMatchObject({ samples: 2, predictedProbability: 0.0025 });
  expect(result.reliability[4]).toMatchObject({ samples: 2, predictedProbability: 0.9975 });
  for (const row of rows)
    expect(applyCheckpointCalibration(row.probability, 6, { checkpoints: [result] })).toBe(
      row.probability,
    );
});

test('new structural fits are versioned without changing saved v1 or v2 offsets', () => {
  const artifact = trainChallengerCandidate(windowSet(80), [], {
    kind: 'market-blend',
    now: afterWindow(79),
  }).artifact;
  expect(artifact.calibration.version).toBe('checkpoint-logit-calibration-v3');
  for (const version of [
    LEGACY_CHALLENGER_CALIBRATION_VERSION,
    CAP_AWARE_CHALLENGER_CALIBRATION_VERSION,
    CHALLENGER_CALIBRATION_VERSION,
  ]) {
    const calibration = {
      ...artifact.calibration,
      version,
      checkpoints: artifact.calibration.checkpoints.map((row) => ({
        ...row,
        status: 'fitted',
        offset: 0.2,
      })),
    };
    expect(isCheckpointCalibration(calibration, artifact.trainedAt)).toBe(true);
    for (const probability of [0, 0.005, 0.01, 0.6, 0.99, 0.995, 1]) {
      const original = getBoundedProbability(
        probability +
          Math.max(-0.05, Math.min(0.05, sigmoid(logit(probability) + 0.2) - probability)),
      );
      expect(applyCheckpointCalibration(probability, 6, calibration)).toBe(original);
    }
  }
});

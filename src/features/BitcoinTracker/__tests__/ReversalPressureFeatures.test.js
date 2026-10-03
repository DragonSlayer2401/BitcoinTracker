import {
  CHALLENGER_MODEL_VERSION,
  LEGACY_CHALLENGER_MODEL_VERSION,
  REVERSAL_PRESSURE_FEATURE_VERSION,
  getChallengerFeatures,
  isChallengerArtifact,
  predictChallengerProbability,
} from '../utils/learning/challengerModel.utils';
import { trainChallengerCandidate } from '../utils/learning/challengerTraining.utils';
import {
  DERIVATIVES_LEARNING_FEATURE_NAMES,
  DERIVATIVES_LEARNING_FEATURE_VERSION,
  LEARNING_FEATURE_NAMES,
} from '../utils/learning/features.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import { predictLogistic } from '../utils/learning/statistics.utils';
import {
  afterWindow,
  clone,
  recordedWindow,
  startOf,
  windowSet,
} from './fixtures/challengerFixtures';

const trainingEvents = windowSet(80);
const newArtifact = trainChallengerCandidate(trainingEvents, [], {
  kind: 'reversal',
  now: afterWindow(79),
}).artifact;

function pressureSnapshot(values = {}) {
  const decision = recordedWindow(80, { baseline: 0.5 }).find((row) => row.event === 'decision');
  return {
    ...decision.learningFeatures,
    schemaVersion: DERIVATIVES_LEARNING_FEATURE_VERSION,
    baselineModelVersion: KALSHI_DERIVATIVES_MODEL_VERSION,
    values: DERIVATIVES_LEARNING_FEATURE_NAMES.map((name) => values[name] ?? 0),
  };
}

function controlledArtifact({ indexes = 10, featureIndex = 6 } = {}) {
  const artifact = clone(newArtifact);
  artifact.pipeline.baselineModelVersion = KALSHI_DERIVATIVES_MODEL_VERSION;
  artifact.pipeline.featureVersion = DERIVATIVES_LEARNING_FEATURE_VERSION;
  artifact.featureVersion = DERIVATIVES_LEARNING_FEATURE_VERSION;
  artifact.model = {
    indexes: Array.from({ length: indexes }, (_, index) => index),
    means: Array(indexes).fill(0),
    scales: Array(indexes).fill(1),
    coefficients: Array.from({ length: indexes + 1 }, (_, index) =>
      index === featureIndex + 1 ? 2 : 0,
    ),
  };
  for (const checkpoint of artifact.calibration.checkpoints) {
    checkpoint.status = 'identity';
    checkpoint.offset = 0;
  }
  return artifact;
}

function predict(artifact, snapshot) {
  return predictChallengerProbability(artifact, {
    baseForecast: {
      available: true,
      aboveProbability: snapshot.baselineAboveProbability,
      target: snapshot.target,
      expiresAt: snapshot.expiresAt,
    },
    learningFeatures: snapshot,
    input: { now: snapshot.featureCutoffAt },
    windowStartAt: startOf(80),
  });
}

test('newly trained V2 reversal candidates freeze their added feature schema without approval', () => {
  expect(newArtifact).toMatchObject({
    version: CHALLENGER_MODEL_VERSION,
    reversalFeatureVersion: REVERSAL_PRESSURE_FEATURE_VERSION,
    status: 'shadow',
  });
  expect(newArtifact.model.indexes).toHaveLength(10);
  expect(newArtifact.activation).toBeUndefined();
  expect(isChallengerArtifact(newArtifact)).toBe(true);
  const legacy = trainChallengerCandidate(windowSet(60), [], {
    kind: 'reversal',
    version: LEGACY_CHALLENGER_MODEL_VERSION,
    now: afterWindow(59),
  }).artifact;
  expect(legacy.reversalFeatureVersion).toBeUndefined();
  expect(legacy.model.indexes).toHaveLength(6);
  expect(isChallengerArtifact(legacy)).toBe(true);
});

test('new reversal fitting can learn changing pressure that its original six inputs omit', () => {
  const events = windowSet(80, 0, { baseline: 0.5, pressure: 0 }).map((row) => {
    if (row.event !== 'decision') return row;
    const index = Number(row.kalshiMarket.ticker.split('CHALLENGER')[1]);
    const change = index % 2 ? 0.8 : -0.8;
    return {
      ...row,
      learningFeatures: {
        ...row.learningFeatures,
        values: row.learningFeatures.values.map((value, position) =>
          ['pressureChange', 'buyPressure15'].includes(LEARNING_FEATURE_NAMES[position])
            ? change
            : value,
        ),
      },
    };
  });
  const trained = trainChallengerCandidate(events, [], {
    kind: 'reversal',
    now: afterWindow(79),
  });
  expect(trained.status).toBe('shadow');
  expect(trained.artifact.model.coefficients[7]).toBeGreaterThan(0);
});

test.each([
  [0.8, 0.4, 0.4],
  [-0.8, -0.4, -0.4],
  [0.8, -0.4, 0],
  [0, 0.4, 0],
])(
  'spot pressure %s and futures pressure %s encode signed agreement %s',
  (spot, futures, expected) => {
    const snapshot = pressureSnapshot({
      flow60Available: 1,
      futuresFlow60Available: 1,
      buyPressure60: spot,
      futuresPressure60: futures,
    });
    const features = getChallengerFeatures('reversal', snapshot, REVERSAL_PRESSURE_FEATURE_VERSION);
    expect(features[7]).toBe(expected);
    expect(features[9]).toBe(1);
  },
);

test('missing optional pressure is neutral and distinguishable from measured balanced pressure', () => {
  const missing = pressureSnapshot({ pressureChange: 0.8, buyPressure60: 0.7 });
  const balanced = pressureSnapshot({
    flow15Available: 1,
    flow60Available: 1,
    futuresFlow60Available: 1,
  });
  expect(
    getChallengerFeatures('reversal', missing, REVERSAL_PRESSURE_FEATURE_VERSION).slice(6),
  ).toEqual([0, 0, 0, 0]);
  expect(
    getChallengerFeatures('reversal', balanced, REVERSAL_PRESSURE_FEATURE_VERSION).slice(6),
  ).toEqual([0, 0, 1, 1]);
  expect(predict(controlledArtifact(), pressureSnapshot())).toBe(0.5);
});

test('changing pressure and cross-market agreement can adjust probability in either direction within the existing cap', () => {
  for (const featureIndex of [6, 7]) {
    const artifact = controlledArtifact({ featureIndex });
    for (const direction of [-1, 1]) {
      const snapshot = pressureSnapshot({
        flow15Available: 1,
        flow60Available: 1,
        futuresFlow60Available: 1,
        buyPressure60: direction * 0.8,
        futuresPressure60: direction * 0.8,
        pressureChange: direction * 0.8,
      });
      const predicted = predict(artifact, snapshot);
      expect(direction * (predicted - 0.5)).toBeGreaterThan(0);
      expect(Math.abs(predicted - 0.5)).toBeLessThanOrEqual(0.0500000001);
    }
  }
});

test('saved V2 artifacts with no new marker retain their original six-input calculation', () => {
  const artifact = controlledArtifact({ indexes: 6, featureIndex: 3 });
  delete artifact.reversalFeatureVersion;
  const first = pressureSnapshot({ flow60Available: 1, buyPressure60: 0.1 });
  const second = pressureSnapshot({
    flow60Available: 1,
    buyPressure60: 0.1,
    flow15Available: 1,
    pressureChange: -0.8,
    futuresFlow60Available: 1,
    futuresPressure60: -0.8,
  });
  expect(isChallengerArtifact(artifact)).toBe(true);
  const original = 0.5 + 0.2 * (predictLogistic(artifact.model, [0, 0, 0, 0.1, 0, 1]) - 0.5);
  expect(predict(artifact, first)).toBe(original);
  expect(predict(artifact, second)).toBe(original);
});

test('unknown feature versions and mismatched fitted dimensions are rejected', () => {
  const artifact = controlledArtifact();
  expect(isChallengerArtifact(artifact)).toBe(true);
  expect(isChallengerArtifact({ ...artifact, reversalFeatureVersion: 'unknown' })).toBe(false);
  const withoutMarker = { ...artifact };
  delete withoutMarker.reversalFeatureVersion;
  expect(isChallengerArtifact(withoutMarker)).toBe(false);
  expect(isChallengerArtifact(controlledArtifact({ indexes: 6 }))).toBe(false);
  expect(getChallengerFeatures('reversal', pressureSnapshot(), 'unknown')).toBeNull();
});

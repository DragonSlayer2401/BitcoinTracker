import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import {
  DERIVATIVES_LEARNING_FEATURE_NAMES,
  DERIVATIVES_LEARNING_FEATURE_VERSION,
  LEARNING_FEATURE_NAMES,
  LEARNING_FEATURE_VERSION,
  getLearningFeatureSchema,
  isLearningFeatureSnapshot,
} from '../utils/learning/features.utils';
import {
  PATTERN_FEATURE_VERSION,
  PATTERN_FEATURE_NAMES,
  PATTERN_FAMILIES,
  getPatternLearningFeatures,
  getConflictingPatternForecastIds,
  isPatternLearningFeatureSnapshot,
} from '../utils/learning/patternFeatures.utils';
import {
  PATTERN_CANDIDATE_KINDS,
  LEGACY_PATTERN_MODEL_VERSION,
  isPatternModelArtifact,
  predictPatternCandidates,
} from '../utils/learning/patternModel.utils';
import {
  getPatternTrainingRows,
  trainPatternCandidates,
} from '../utils/learning/patternTraining.utils';
import { PATTERN_FEATURE_DEFINITIONS } from '../utils/patterns/patternConfig';
import { splitLearningWindows } from '../utils/learning/training.utils';

const MINUTE = 60_000;
const START = 1_800_000_000_000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const contractFor = (index) => ({
  ticker: `KXBTC15M-PATTERN${index}`,
  eventTicker: `KXBTC15M-PATTERN${index}`,
  seriesTicker: 'KXBTC15M',
  target: 100_000,
  startsAt: START + index * 17 * MINUTE,
  expiresAt: START + index * 17 * MINUTE + 15 * MINUTE,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  supported: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
});
function baselineFeatures(contract, cutoffAt, derivatives = false) {
  const names = derivatives ? DERIVATIVES_LEARNING_FEATURE_NAMES : LEARNING_FEATURE_NAMES;
  return {
    schemaVersion: derivatives ? DERIVATIVES_LEARNING_FEATURE_VERSION : LEARNING_FEATURE_VERSION,
    available: true,
    baselineAboveProbability: 0.55,
    targetDistance: 0,
    target: contract.target,
    expiresAt: contract.expiresAt,
    featureCutoffAt: cutoffAt,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    referenceSource: 'cf-brti',
    featureInputSource: 'cf-brti-history',
    baselineModelVersion: derivatives ? KALSHI_DERIVATIVES_MODEL_VERSION : 'kalshi-brti-average-v2',
    settlementKnownFraction: 0,
    values: names.map(() => 0),
  };
}
function patternInput(learningFeatures, outcome = 1) {
  return {
    version: 'brti-patterns-v2',
    source: 'brti',
    capturedAt: learningFeatures.featureCutoffAt,
    availableAt: learningFeatures.featureCutoffAt,
    targetPrice: learningFeatures.target,
    families: Object.fromEntries(PATTERN_FAMILIES.map((family) => [family, { available: true }])),
    features: Object.fromEntries(
      PATTERN_FEATURE_DEFINITIONS.map(({ name }) => [
        name,
        name === 'candleBodyDirection' ? outcome * 2 - 1 : 0,
      ]),
    ),
  };
}
function recordedContract(index) {
  const market = contractFor(index);
  const recorder = createResearchRecorder({ recorderId: 'pattern-tests' });
  const events = [];
  for (const minutes of [12, 9, 6, 3, 1]) {
    const now = market.expiresAt - minutes * MINUTE;
    const learningFeatures = baselineFeatures(market, now);
    const chartPatterns = patternInput(learningFeatures, index % 2);
    const patternLearningFeatures = getPatternLearningFeatures({ learningFeatures, chartPatterns });
    const captures = recorder.advance({
      now,
      ticker: { time: now, receivedAt: now, price: 100_001 },
      markets: [{ ...market, receivedAt: now }],
      getEstimate: () => ({
        available: true,
        aboveProbability: 0.55,
        belowProbability: 0.45,
        direction: 'above',
        modelVersion: learningFeatures.baselineModelVersion,
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        learningFeatures,
        patternLearningFeatures,
        chartPatterns,
        kalshi: {
          referenceSource: 'cf-brti',
          priceDynamicsSource: 'cf-brti-history',
          observedSampleCount: 0,
        },
      }),
    }).rows;
    // These synthetic fixture records are captured here before their outcome exists.
    events.push(...captures.map((row) => ({ ...row, patternLearningFeatures, chartPatterns })));
  }
  const now = market.expiresAt + 1000;
  events.push(
    ...recorder.advance({
      now,
      getEstimate: () => ({ available: false }),
      ticker: { time: now, receivedAt: now, price: 100_001 },
      markets: [
        {
          ...market,
          receivedAt: now,
          status: 'finalized',
          result: index % 2 ? 'yes' : 'no',
          settlementPrice: index % 2 ? 100_001 : 99_999,
        },
      ],
    }).rows,
  );
  return events;
}

test.each([false, true])(
  'pattern encoding preserves the original historical baseline schema (derivatives %s)',
  (derivatives) => {
    const market = contractFor(0);
    const baseline = baselineFeatures(market, market.startsAt + 3 * MINUTE, derivatives);
    const original = clone(baseline);
    const snapshot = getPatternLearningFeatures({
      learningFeatures: baseline,
      chartPatterns: patternInput(baseline),
    });
    expect(snapshot.schemaVersion).toBe(PATTERN_FEATURE_VERSION);
    expect(snapshot.values).toHaveLength(PATTERN_FEATURE_NAMES.length);
    expect(snapshot.baselineFeatures).toEqual(original);
    expect(snapshot.baselineFeatures).not.toBe(baseline);
    expect(getLearningFeatureSchema(LEARNING_FEATURE_VERSION).names).toHaveLength(26);
    expect(getLearningFeatureSchema(DERIVATIVES_LEARNING_FEATURE_VERSION).names).toHaveLength(42);
    expect(
      isLearningFeatureSnapshot(snapshot, {
        target: market.target,
        expiresAt: market.expiresAt,
        cutoffAt: baseline.featureCutoffAt,
      }),
    ).toBe(false);
    expect(
      isPatternLearningFeatureSnapshot(snapshot, {
        target: market.target,
        expiresAt: market.expiresAt,
        cutoffAt: baseline.featureCutoffAt,
        baselineFeatures: baseline,
      }),
    ).toBe(true);
    baseline.values[0] = 1;
    expect(snapshot.baselineFeatures).toEqual(original);
  },
);

test('missing, stale, wrong-target and future pattern inputs retain an explicitly available baseline snapshot', () => {
  const market = contractFor(0);
  const baseline = baselineFeatures(market, market.startsAt + 3 * MINUTE);
  const original = clone(baseline);
  const patterns = patternInput(baseline);
  for (const chartPatterns of [
    undefined,
    { ...patterns, availableAt: patterns.availableAt + 1 },
    { ...patterns, availableAt: patterns.availableAt - 120_001 },
    { ...patterns, targetPrice: patterns.targetPrice + 1 },
  ]) {
    const snapshot = getPatternLearningFeatures({ learningFeatures: baseline, chartPatterns });
    expect(snapshot).toMatchObject({
      available: true,
      patternAvailable: false,
      baselineFeatures: original,
    });
    expect(snapshot.values.every((value) => value === 0)).toBe(true);
  }
  expect(baseline).toEqual(original);
});

test('missing feature flags distinguish observed zero and preserve family availability', () => {
  const market = contractFor(0);
  const baseline = baselineFeatures(market, market.startsAt + 3 * MINUTE);
  const patterns = patternInput(baseline);
  patterns.features.compressionPressureConfirmation = null;
  const snapshot = getPatternLearningFeatures({
    learningFeatures: baseline,
    chartPatterns: patterns,
  });
  const missingIndex = PATTERN_FEATURE_NAMES.indexOf('compressionPressureConfirmationAvailable');
  expect(snapshot.values[missingIndex]).toBe(0);
  expect(snapshot.familyAvailability.compressionExpansion).toBe(true);
  expect(snapshot.values[PATTERN_FEATURE_NAMES.indexOf('compressionRatioAvailable')]).toBe(1);
});

test('conflicting pattern duplicates and malformed capture availability never enter training', () => {
  const events = recordedContract(0);
  const first = events.find((row) => row.event === 'decision');
  const now = contractFor(1).startsAt;
  const duplicate = clone(first);
  duplicate.patternLearningFeatures.values[0] = 1;
  expect(getPatternTrainingRows([...events, duplicate], { now })).toMatchObject({
    conflictingSnapshots: 1,
    missingSnapshots: 1,
  });
  expect(getPatternTrainingRows([...events, duplicate], { now }).rows).toHaveLength(4);
  expect(
    getConflictingPatternForecastIds([...events, { ...duplicate, recordedAt: now + 1 }], now).size,
  ).toBe(0);
  for (const change of [
    { patternAvailable: false },
    { availableAt: first.capturedAt + 1 },
    { familyAvailability: {} },
  ]) {
    const invalid = events.map((row) =>
      row === first
        ? { ...row, patternLearningFeatures: { ...row.patternLearningFeatures, ...change } }
        : row,
    );
    expect(getPatternTrainingRows(invalid, { now }).rows).toHaveLength(4);
  }
});

test('current training excludes legacy detector captures while preserving legacy feature validation', () => {
  const legacy = recordedContract(0).map((row) => {
    if (!row.patternLearningFeatures) return row;
    const chartPatterns = { ...row.chartPatterns, version: 'brti-patterns-v1' };
    return {
      ...row,
      chartPatterns,
      patternLearningFeatures: getPatternLearningFeatures({
        learningFeatures: row.learningFeatures,
        chartPatterns,
      }),
    };
  });
  const snapshot = legacy.find((row) => row.patternLearningFeatures).patternLearningFeatures;
  expect(snapshot.schemaVersion).toBe('deadline-pattern-features-v4');
  expect(snapshot.values).toHaveLength(PATTERN_FEATURE_NAMES.length);
  expect(
    isPatternLearningFeatureSnapshot(snapshot, {
      target: snapshot.target,
      expiresAt: snapshot.expiresAt,
      cutoffAt: snapshot.featureCutoffAt,
    }),
  ).toBe(true);
  const current = recordedContract(1);
  const before = JSON.stringify(legacy);
  const training = getPatternTrainingRows([...legacy, ...current], {
    now: contractFor(2).startsAt,
  });
  expect(training.rows).toHaveLength(5);
  expect(
    training.rows.every(
      (row) => row.patternLearningFeatures.schemaVersion === PATTERN_FEATURE_VERSION,
    ),
  ).toBe(true);
  expect(training.missingSnapshots).toBe(5);
  expect(JSON.stringify(legacy)).toBe(before);
});

describe('fixed shadow suite', () => {
  let events;
  let training;
  let now;
  beforeAll(() => {
    events = Array.from({ length: 260 }, (_, index) => recordedContract(index)).flat();
    now = contractFor(260).startsAt;
    training = trainPatternCandidates(events, { now });
  });

  test('fits combined, fitted control and five ablations using independent chronological contracts', () => {
    expect(training.status).toBe('shadow');
    expect(training.artifacts.map((model) => model.kind)).toEqual(PATTERN_CANDIDATE_KINDS);
    expect(training.counts).toMatchObject({
      training: 130,
      calibration: 65,
      test: 65,
      independentWindows: 260,
    });
    expect(training.artifacts.every(isPatternModelArtifact)).toBe(true);
    expect(
      training.artifacts.every((model) => model.evaluation.eligibleForPromotion === false),
    ).toBe(true);
    const combined = training.artifacts[0];
    const control = training.artifacts[1];
    expect(combined.evaluation.candidate.brier).toBeLessThan(control.evaluation.candidate.brier);
    expect(control.model.indexes).toHaveLength(LEARNING_FEATURE_NAMES.length);
    const split = splitLearningWindows(getPatternTrainingRows(events, { now }).rows);
    const trainIds = new Set(split.trainingCheckpoints.map((row) => row.marketTicker));
    expect(split.calibrationCheckpoints.every((row) => !trainIds.has(row.marketTicker))).toBe(true);
    expect(split.test.every((row) => row.windowStartAt >= split.calibrationCutoffAt)).toBe(true);
  });

  test('old records remain untouched and cannot be backfilled by the trainer', () => {
    const historical = events.map(({ patternLearningFeatures, chartPatterns, ...row }) => row);
    const before = JSON.stringify(historical);
    expect(trainPatternCandidates(historical, { now })).toMatchObject({
      status: 'insufficient-data',
      artifacts: [],
    });
    expect(JSON.stringify(historical)).toBe(before);
    expect(getPatternTrainingRows(historical, { now }).missingSnapshots).toBe(1300);
  });

  test('legacy artifacts retain their positional dimensions and score their original schema', () => {
    const model = {
      ...clone(training.artifacts[0]),
      version: LEGACY_PATTERN_MODEL_VERSION,
      featureVersion: 'deadline-pattern-features-v4',
      patternVersion: 'brti-patterns-v1',
    };
    model.id = `${model.version}-${model.kind}-${model.suiteId}`;
    expect(isPatternModelArtifact(model)).toBe(true);
    expect(model.model.coefficients).toHaveLength(training.artifacts[0].model.coefficients.length);
    const market = contractFor(261);
    const baseline = baselineFeatures(market, market.startsAt + 3 * MINUTE);
    const snapshot = getPatternLearningFeatures({
      learningFeatures: baseline,
      chartPatterns: { ...patternInput(baseline), version: 'brti-patterns-v1' },
    });
    const [prediction] = predictPatternCandidates({
      candidates: [model],
      snapshot,
      windowStartAt: market.startsAt,
    });
    expect(prediction).toMatchObject({
      modelVersion: LEGACY_PATTERN_MODEL_VERSION,
      modelUsed: true,
    });
  });

  test('only models trained before a future contract start emit frozen shadow scores', () => {
    const market = contractFor(261);
    const baseline = baselineFeatures(market, market.startsAt + 3 * MINUTE);
    const snapshot = getPatternLearningFeatures({
      learningFeatures: baseline,
      chartPatterns: patternInput(baseline),
    });
    const predictions = predictPatternCandidates({
      candidates: training.artifacts,
      snapshot,
      windowStartAt: market.startsAt,
    });
    expect(predictions).toHaveLength(7);
    expect(
      predictions.every(
        (prediction) => prediction.modelUsed && prediction.trainedAt <= market.startsAt,
      ),
    ).toBe(true);
    expect(
      predictPatternCandidates({
        candidates: training.artifacts,
        snapshot,
        windowStartAt: now - 1,
      }),
    ).toEqual([]);
    const unavailable = getPatternLearningFeatures({ learningFeatures: baseline });
    expect(
      predictPatternCandidates({
        candidates: training.artifacts,
        snapshot: unavailable,
        windowStartAt: market.startsAt,
      }),
    ).toEqual(
      predictions.map((prediction) =>
        expect.objectContaining({
          modelId: prediction.modelId,
          aboveProbability: 0.55,
          modelUsed: false,
        }),
      ),
    );
  });

  test('later observations and unresolved labels cannot change a fit at its earlier cutoff', () => {
    const withFuture = [...events, ...recordedContract(270)];
    const repeated = trainPatternCandidates(withFuture, { now });
    expect(repeated.artifacts).toEqual(training.artifacts);
    const changed = clone(training.artifacts[0]);
    changed.model.indexes.pop();
    expect(isPatternModelArtifact(changed)).toBe(false);
  });
});

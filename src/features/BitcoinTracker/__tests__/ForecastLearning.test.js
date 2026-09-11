import {
  getLearningFeatures,
  isLearningFeatureSnapshot,
  LEARNING_FEATURE_NAMES,
  LEARNING_FEATURE_VERSION,
} from '../utils/learning/features.utils';
import {
  analyzeForecastEvidence as analyzeContractEvidence,
  analyzeSavedForecasts,
  getVerifiedLearningRows as getVerifiedContractRows,
  groupOverlappingWindows,
} from '../utils/learning/evaluation.utils';
import {
  applyOutcomeModel,
  isOutcomeModelArtifact,
  OUTCOME_MODEL_VERSION,
  predictOutcomeCandidate,
} from '../utils/learning/model.utils';
import {
  evaluateShadowCandidate,
  splitLearningWindows,
  trainOutcomeCandidate as trainContractCandidate,
} from '../utils/learning/training.utils';
import { KALSHI_OUTCOME_DEFINITION as DEADLINE_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { createLearningService as createContractLearningService } from '@/services/research/learning.service';

// All learning fixtures represent actual Kalshi contracts.
const contractOptions = { outcomeDefinition: DEADLINE_OUTCOME_DEFINITION };
const analyzeForecastEvidence = (events, now) =>
  analyzeContractEvidence(events, now, contractOptions);
const getVerifiedLearningRows = (events, now) =>
  getVerifiedContractRows(events, now, contractOptions);
const trainOutcomeCandidate = (events, options) =>
  trainContractCandidate(events, { ...options, ...contractOptions });
const createLearningService = (repository) =>
  createContractLearningService(repository, contractOptions);

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/services/research/research.repository', () => ({}));

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const BASE = {
  outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  kalshi: {
    referenceSource: 'coinbase-proxy',
    priceDynamicsSource: 'coinbase-candles',
    observedSampleCount: 0,
  },
  available: true,
  modelVersion: 'kalshi-brti-average-v2',
  aboveProbability: 0.55,
  belowProbability: 0.45,
  lowerBound: 95,
  upperBound: 105,
  direction: 'above',
  horizonMinutes: 12,
};
const featureValues = (outcome = 1) =>
  LEARNING_FEATURE_NAMES.map((_, index) => (index === 3 ? (outcome ? 1 : -1) : 0));
const snapshot = (time, expiresAt, outcome = 1) => ({
  outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  referenceSource: 'coinbase-proxy',
  featureInputSource: 'coinbase-candles',
  baselineModelVersion: BASE.modelVersion,
  settlementKnownFraction: 0,
  schemaVersion: LEARNING_FEATURE_VERSION,
  available: true,
  baselineAboveProbability: 0.55,
  targetDistance: 0,
  featureCutoffAt: time,
  target: 100,
  expiresAt,
  values: featureValues(outcome),
});

function eventsFor(
  index,
  {
    start = START,
    outcome = index % 2,
    probability = 0.55,
    cohort = 'kalshi-background',
    features = true,
  } = {},
) {
  const windowStartAt = start + index * 17 * MINUTE;
  const capturedAt = windowStartAt + 3 * MINUTE;
  const expiresAt = windowStartAt + 15 * MINUTE;
  const kalshiMarket = {
    ticker: `KXBTC15M-TEST${index}`,
    eventTicker: `KXBTC15M-TEST${index}`,
    seriesTicker: 'KXBTC15M',
    target: 100,
    startsAt: windowStartAt,
    expiresAt,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  };
  const common = {
    kalshiMarket,
    forecastId: `forecast-${start}-${index}`,
    source: 'Coinbase BTC-USD',
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
    target: 100,
    windowStartAt,
    expiresAt,
    cohort,
  };
  const decision = {
    ...common,
    eventId: `${common.forecastId}:decision`,
    event: 'decision',
    recordedAt: capturedAt,
    inputObservedAt: capturedAt,
    featureCutoffAt: capturedAt,
    inputStatus: 'captured',
    capturedAt,
    aboveProbability: probability,
    belowProbability: 1 - probability,
    spot: 101,
    modelVersion: BASE.modelVersion,
    learningFeatures: features
      ? { ...snapshot(capturedAt, expiresAt, outcome), baselineAboveProbability: probability }
      : null,
  };
  const result = {
    ...common,
    eventId: `${common.forecastId}:outcome`,
    event: 'outcome',
    recordedAt: expiresAt + 1000,
    outcomeStatus: 'observed',
    observedPrice: outcome ? 102 : 98,
    observedAt: expiresAt,
    kalshiOutcome: {
      status: 'observed',
      outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
      marketTicker: kalshiMarket.ticker,
      target: 100,
      expiresAt,
      observedPrice: outcome ? 102 : 98,
      observedAt: expiresAt,
      result: outcome ? 'yes' : 'no',
      outcome: outcome ? 'above' : 'below',
      comparison: 'greater_or_equal',
      roundDigits: 2,
      confirmedThrough: expiresAt + 1000,
      settledAt: expiresAt + 1000,
    },
    observedTradeId: index + 1,
    confirmedThrough: expiresAt + 1000,
    completeSince: windowStartAt,
    outcome: outcome ? 'above' : 'below',
  };
  return [decision, result];
}

function artifact() {
  const size = LEARNING_FEATURE_NAMES.length;
  return {
    id: `${OUTCOME_MODEL_VERSION}-test`,
    version: OUTCOME_MODEL_VERSION,
    status: 'shadow',
    trainedAt: START,
    featureVersion: LEARNING_FEATURE_VERSION,
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
    trainingCutoffAt: START - 3000,
    calibrationCutoffAt: START - 2000,
    evaluationCutoffAt: START - 1000,
    shadowStartsAt: START,
    applicability: {
      referenceSources: ['coinbase-proxy'],
      featureInputSources: ['coinbase-candles'],
      baselineModelVersion: BASE.modelVersion,
      minimumHorizonMinutes: 12,
      maximumHorizonMinutes: 12,
      minimumTargetDistance: -1,
      maximumTargetDistance: 1,
      availabilityPatterns: ['0000000'],
    },
    model: {
      indexes: Array.from({ length: size }, (_, index) => index),
      means: Array(size).fill(0),
      scales: Array(size).fill(1),
      coefficients: [0, ...Array.from({ length: size }, (_, index) => (index === 3 ? 5 : 0))],
    },
    calibration: {
      version: 'platt-v1',
      model: { indexes: [0], means: [0], scales: [1], coefficients: [0, 1] },
    },
    evaluation: { eligibleForShadow: true },
  };
}

function liveInput() {
  const now = START + 3 * MINUTE;
  return {
    forecast: BASE,
    spot: 101,
    target: 100,
    now,
    expiresAt: START + 15 * MINUTE,
    conditions: {
      available: true,
      features: {
        latestCompletedAt: now,
        effectiveMinuteVolatility: 0.001,
        logReturn1Minute: -0.001,
        logReturn3Minutes: -0.002,
        logReturn5Minutes: -0.003,
        logReturn15Minutes: -0.004,
        logReturnAcceleration3Minutes: -0.001,
        relativeVolume5To30Minutes: 1.5,
        latestRangeToMedianRatio: 2,
        spreadFraction: 0.00001,
        closePosition: 0.2,
      },
    },
    stream: {
      status: 'live',
      quality: { heartbeatAt: now },
      flow: {
        windows: {
          15: { available: true, imbalance: -0.8 },
          60: { available: true, imbalance: -0.2 },
          180: { available: true, imbalance: 0.1 },
        },
      },
      liquidity: {
        available: true,
        updatedAt: now,
        depth: { 10: { imbalance: -0.5 } },
        depthChange60: { available: true, bidFraction: -0.4, askFraction: 0.1 },
      },
    },
  };
}

describe('deadline learning features', () => {
  test('captures weakening buying pressure and shrinking bid liquidity as model inputs', () => {
    const inputs = liveInput();
    const result = getLearningFeatures(inputs);
    expect(result.available).toBe(true);
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('pressureChange')]).toBeCloseTo(-0.6);
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('depthChange')]).toBeCloseTo(-0.5);
    expect(
      isLearningFeatureSnapshot(result, {
        target: 100,
        expiresAt: inputs.expiresAt,
        cutoffAt: inputs.now,
      }),
    ).toBe(true);
  });
  test('represents unavailable optional feeds explicitly without blocking a prediction', () => {
    const result = getLearningFeatures({ ...liveInput(), stream: null });
    expect(result.available).toBe(true);
    expect(result.missingFeeds).toContain('flow-15');
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('flow15Available')]).toBe(0);
  });
  test('native index features preserve missing volume and spread instead of inventing exchange data', () => {
    const inputs = liveInput();
    inputs.forecast = {
      ...BASE,
      kalshi: {
        referenceSource: 'cf-brti',
        priceDynamicsSource: 'cf-brti-history',
        observedSampleCount: 0,
      },
    };
    delete inputs.conditions.features.relativeVolume5To30Minutes;
    delete inputs.conditions.features.spreadFraction;
    const result = getLearningFeatures({ ...inputs, stream: null });
    expect(result).toMatchObject({
      available: true,
      baselineModelVersion: BASE.modelVersion,
      referenceSource: 'cf-brti',
      featureInputSource: 'cf-brti-history',
    });
    expect(result.missingFeeds).toEqual(expect.arrayContaining(['volume', 'spread']));
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('volumeAvailable')]).toBe(0);
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('spreadAvailable')]).toBe(0);
    expect(
      isLearningFeatureSnapshot(result, {
        target: inputs.target,
        expiresAt: inputs.expiresAt,
        cutoffAt: inputs.now,
      }),
    ).toBe(true);
    const available = getLearningFeatures(liveInput());
    expect(available.values[LEARNING_FEATURE_NAMES.indexOf('volumeAvailable')]).toBe(1);
    expect(available.values[LEARNING_FEATURE_NAMES.indexOf('spreadAvailable')]).toBe(1);
  });
  test('excludes stale or future pressure and book data', () => {
    const input = liveInput();
    input.stream.quality.heartbeatAt = input.now + 1;
    input.stream.liquidity.updatedAt = input.now - 6000;
    const result = getLearningFeatures(input);
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('buyPressure15')]).toBe(0);
    expect(result.values[LEARNING_FEATURE_NAMES.indexOf('depthAvailable')]).toBe(0);
  });
  test('does not reconstruct missing required candle features', () => {
    const input = liveInput();
    delete input.conditions.features.logReturn3Minutes;
    expect(getLearningFeatures(input)).toMatchObject({
      available: false,
      baselineModelVersion: BASE.modelVersion,
      referenceSource: 'coinbase-proxy',
      featureInputSource: 'coinbase-candles',
    });
  });
  test('rejects future candles and changed targets', () => {
    const input = liveInput();
    input.conditions.features.latestCompletedAt++;
    expect(getLearningFeatures(input).available).toBe(false);
    expect(
      isLearningFeatureSnapshot(snapshot(START, START + MINUTE), {
        target: 99,
        expiresAt: START + MINUTE,
        cutoffAt: START,
      }),
    ).toBe(false);
  });
});

describe('saved forecast outcome analysis', () => {
  test('counts missed checkpoints in publication coverage but never as incorrect predictions', () => {
    const missed = eventsFor(1);
    missed[0].aboveProbability = null;
    missed[0].belowProbability = null;
    const report = analyzeForecastEvidence([...eventsFor(0), ...missed], START + 40 * MINUTE);
    expect(report.counts.savedForecasts).toBe(2);
    expect(report.callCoverage).toBe(0.5);
    expect(report.metrics.examples).toBe(1);
  });
  test('uses one saved decision, its original target, and only the verified deadline event', () => {
    const events = eventsFor(0);
    const observation = {
      ...events[0],
      event: 'observation',
      recordedAt: events[0].recordedAt + 1000,
      aboveProbability: 0.9,
    };
    const data = getVerifiedLearningRows([...events, observation, events[0]], START + 20 * MINUTE);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].probability).toBe(0.55);
    expect(data.rows[0].target).toBe(100);
  });
  test.each([
    [
      'target changed',
      (outcome) => {
        outcome.target = 99;
      },
    ],
    [
      'post-deadline trade',
      (outcome) => {
        outcome.observedAt = outcome.expiresAt + 1;
      },
    ],
    [
      'missing continuity',
      (outcome) => {
        outcome.kalshiOutcome = null;
      },
    ],
    [
      'unconfirmed deadline',
      (outcome) => {
        outcome.confirmedThrough = outcome.expiresAt;
      },
    ],
    [
      'incorrect supplied label',
      (outcome) => {
        outcome.outcome = 'above';
      },
    ],
  ])('rejects invalid training outcomes: %s', (_, change) => {
    const events = eventsFor(0);
    change(events[1]);
    expect(getVerifiedLearningRows(events, START + 20 * MINUTE).rows).toHaveLength(0);
  });
  test('excludes future outcomes and late reconstructed features', () => {
    const events = eventsFor(0);
    expect(getVerifiedLearningRows(events, START + 10 * MINUTE).rows).toHaveLength(0);
    events[0].learningFeatures.featureCutoffAt = events[0].expiresAt;
    const data = getVerifiedLearningRows(events, START + 20 * MINUTE);
    expect(data.rows[0].features).toBeNull();
    expect(data.counts.missingLearningFeatures).toBe(1);
  });
  test('reports a true finish reversal and false alarm without treating absent outcomes as losses', () => {
    const events = [
      ...eventsFor(0, { probability: 0.3 }),
      ...eventsFor(1, { probability: 0.3 }),
      eventsFor(2)[0],
    ];
    const report = analyzeForecastEvidence(events, START + 60 * MINUTE);
    expect(report.metrics.reversals).toBe(1);
    expect(report.metrics.reversalRecall).toBe(1);
    expect(report.metrics.reversalFalseAlarmRate).toBe(0.5);
    expect(report.metrics.callAccuracy).toBe(0.5);
    expect(report.counts.unresolved).toBe(1);
    expect(report.failedFixedPredictions).toBe(1);
    expect(report.metrics.calibrationBins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2);
  });
  test('audits each learned artifact separately and scores only captured price intervals', () => {
    const first = eventsFor(0);
    const second = eventsFor(1);
    const third = eventsFor(2);
    first[0].modelVersion = OUTCOME_MODEL_VERSION;
    first[0].learning = { modelId: 'release-a' };
    second[0].modelVersion = OUTCOME_MODEL_VERSION;
    second[0].learning = { modelId: 'release-b' };
    second[0].intervalCoverage = 0.8;
    second[0].intervalLow = 99;
    second[0].intervalHigh = 103;
    third[0].intervalCoverage = 0.8;
    third[0].intervalLow = 100;
    third[0].intervalHigh = 101;
    const report = analyzeForecastEvidence([...first, ...second, ...third], START + 60 * MINUTE);
    expect(report.byModel.map((row) => row.modelId)).toEqual(['release-a', 'release-b', null]);
    expect(report.metrics.intervalExamples).toBe(2);
    expect(report.metrics.central80IntervalCoverage).toBe(0.5);
  });
  test('keeps no calls in publication coverage and rejects a label inconsistent with official proof', () => {
    const noCall = eventsFor(0);
    noCall[0].aboveProbability = null;
    noCall[0].belowProbability = null;
    const tie = eventsFor(1);
    tie[1].observedPrice = 100;
    tie[1].outcome = 'equal';
    const report = analyzeForecastEvidence([...noCall, ...tie], START + 40 * MINUTE);
    expect(report.callCoverage).toBe(0.5);
    expect(report.counts.invalidOutcomes).toBe(1);
    expect(report.counts.learningExamples).toBe(0);
  });
  test('groups connected overlaps and repeated manual targets together', () => {
    const rows = [
      { id: 'a', windowStartAt: 0, expiresAt: 10 },
      { id: 'b', windowStartAt: 9, expiresAt: 20 },
      { id: 'c', windowStartAt: 19, expiresAt: 30 },
      { id: 'd', windowStartAt: 30, expiresAt: 40 },
    ];
    expect(groupOverlappingWindows(rows).map((group) => group.rows.length)).toEqual([3, 1]);
  });
});

describe('chronological training and immutable model application', () => {
  test('manual windows cannot bridge background quarters or inflate training evidence', () => {
    const events = Array.from({ length: 320 }, (_, index) =>
      eventsFor(index, { probability: 0.65 }),
    ).flat();
    const manual = eventsFor(400, { cohort: 'manual' });
    manual[0].windowStartAt = START;
    manual[0].expiresAt = events.at(-1).expiresAt;
    manual[1].windowStartAt = START;
    manual[1].expiresAt = manual[0].expiresAt;
    const now = Math.max(manual[1].recordedAt, events.at(-1).recordedAt) + MINUTE;
    const result = trainOutcomeCandidate([...events, ...manual], { now });
    expect(result.counts.independentWindows).toBe(320);
  });
  test('returns an explicit insufficient evidence status, never a synthetic fitted model', () => {
    const result = trainOutcomeCandidate(eventsFor(0), { now: START + 20 * MINUTE });
    expect(result.status).toBe('insufficient-data');
    expect(result.artifact).toBeNull();
  });
  test('purges whole boundary groups whose outcome knowledge crosses the next period', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      windowStartAt: index * 20,
      expiresAt: index * 20 + 15,
      capturedAt: index * 20 + 3,
      resolvedAt: index === 3 ? 90 : index * 20 + 16,
    }));
    const split = splitLearningWindows(rows);
    expect(split.train.map((row) => row.id)).toEqual(['0', '1', '2', '3']);
    expect(split.calibration.map((row) => row.id)).toEqual(['5']);
    expect(split.purgedGroups).toBe(1);
    expect(split.calibration.every((row) => row.windowStartAt >= split.trainingCutoffAt)).toBe(
      true,
    );
    expect(split.test.every((row) => row.windowStartAt >= split.calibrationCutoffAt)).toBe(true);
  });
  test('fits a future-outcome classifier but leaves a successful candidate in shadow mode', () => {
    const events = Array.from({ length: 320 }, (_, index) =>
      eventsFor(index, { probability: 0.65 }),
    ).flat();
    const now = events.at(-1).recordedAt + MINUTE;
    const result = trainOutcomeCandidate(events, { now });
    expect(result.status).toBe('shadow');
    expect(isOutcomeModelArtifact(result.artifact)).toBe(true);
    expect(result.artifact.evaluation.candidate.callAccuracy).toBe(1);
    const time = now + MINUTE;
    const features = snapshot(time, time + 12 * MINUTE, 0);
    expect(predictOutcomeCandidate(result.artifact, features)).toBeLessThan(0.5);
    expect(
      applyOutcomeModel(
        BASE,
        { learningFeatures: features, now: time, target: 100, expiresAt: features.expiresAt },
        result.artifact,
      ),
    ).toBe(BASE);
  });
  test('test-period changes cannot alter training normalization or calibration fitting', () => {
    const events = Array.from({ length: 320 }, (_, index) =>
      eventsFor(index, { probability: 0.65 }),
    ).flat();
    const now = events.at(-1).recordedAt + MINUTE;
    const first = trainOutcomeCandidate(events, { now }).artifact;
    for (const event of events)
      if (event.event === 'decision' && event.windowStartAt > first.calibrationCutoffAt)
        event.learningFeatures.values[3] *= -1;
    const second = trainOutcomeCandidate(events, { now }).artifact;
    expect(second.model).toEqual(first.model);
    expect(second.calibration).toEqual(first.calibration);
    expect(second.evaluation.eligibleForShadow).toBe(false);
  });
  test('only prospectively activated models change probabilities; the old distribution is removed', () => {
    const model = artifact();
    const time = START + MINUTE;
    const expiresAt = time + 12 * MINUTE;
    model.activation = {
      modelId: model.id,
      activatedAt: time,
      shadowEvaluation: { eligibleForPromotion: true },
    };
    const frozenBase = Object.freeze({ ...BASE });
    const frozenModel = Object.freeze(model);
    const result = applyOutcomeModel(
      frozenBase,
      { learningFeatures: snapshot(time, expiresAt, 0), target: 100, expiresAt, now: time },
      frozenModel,
    );
    expect(result.aboveProbability).toBeLessThan(0.5);
    expect(result.belowProbability).toBeCloseTo(1 - result.aboveProbability);
    expect(result.modelVersion).toBe(OUTCOME_MODEL_VERSION);
    expect(result.learning.baselineAboveProbability).toBe(0.55);
    expect(result.lowerBound).toBeNull();
    expect(result.upperBound).toBeNull();
    expect(result.intervalAvailable).toBe(false);
    expect(frozenBase.aboveProbability).toBe(0.55);
  });
  test.each(['unseen-horizon', 'unseen-feed-availability', 'far-target'])(
    'uses the recorded baseline outside the learned domain: %s',
    (mode) => {
      const model = artifact();
      const time = START + MINUTE;
      const expiresAt = time + (mode === 'unseen-horizon' ? 6 : 12) * MINUTE;
      const features = snapshot(time, expiresAt, 0);
      if (mode === 'unseen-feed-availability') features.values[19] = 1;
      if (mode === 'far-target') features.targetDistance = 5;
      model.activation = {
        modelId: model.id,
        activatedAt: time,
        shadowEvaluation: { eligibleForPromotion: true },
      };
      expect(predictOutcomeCandidate(model, features)).toBe(0.55);
      expect(
        applyOutcomeModel(
          BASE,
          { learningFeatures: features, target: 100, expiresAt, now: time },
          model,
        ),
      ).toBe(BASE);
    },
  );
  test('does not turn a new continuous feature extreme into a publication blocker', () => {
    const model = artifact();
    const features = snapshot(START + MINUTE, START + 13 * MINUTE);
    features.values[3] = 8;
    expect(predictOutcomeCandidate(model, features)).toBeGreaterThan(0.9);
  });
  test.each(['future-activation', 'wrong-target', 'missing-features', 'negative-calibration'])(
    'retains the live base when learned model use is invalid: %s',
    (mode) => {
      const model = artifact();
      const time = START + MINUTE;
      const expiresAt = time + 12 * MINUTE;
      model.activation = {
        modelId: model.id,
        activatedAt: time,
        shadowEvaluation: { eligibleForPromotion: true },
      };
      const context = {
        learningFeatures: snapshot(time, expiresAt),
        target: 100,
        expiresAt,
        now: time,
      };
      if (mode === 'future-activation') model.activation.activatedAt++;
      if (mode === 'wrong-target') context.target = 99;
      if (mode === 'missing-features') context.learningFeatures = null;
      if (mode === 'negative-calibration') model.calibration.model.coefficients[1] = -1;
      expect(applyOutcomeModel(BASE, context, model)).toBe(BASE);
    },
  );
});

describe('server learning workflow', () => {
  function repository(events = [], models = []) {
    let active = null;
    return {
      getLearningEvidenceRows: jest.fn(async () => events),
      readModelArtifacts: jest.fn(async () => models),
      getActiveModelArtifact: jest.fn(async () => active),
      readStoredForecasts: jest.fn(async () => ({ rows: [], nextCursor: null })),
      acquireLearningLease: jest.fn(async () => true),
      releaseLearningLease: jest.fn(async () => undefined),
      writeModelArtifact: jest.fn(async (model) => {
        models.push(model);
      }),
      activateModelArtifact: jest.fn(async (id, activation) => {
        active = {
          ...models.find((model) => model.id === id),
          activation: { modelId: id, ...activation },
        };
      }),
    };
  }
  test('a read-only status does not fit or activate any model', async () => {
    const store = repository(eventsFor(0));
    const service = createLearningService(store);
    const status = await service.getLearningStatus({ now: START + 20 * MINUTE });
    expect(status.training.status).toBe('insufficient-data');
    expect(status.analysis.counts.learningExamples).toBe(1);
    expect(store.writeModelArtifact).not.toHaveBeenCalled();
    expect(store.activateModelArtifact).not.toHaveBeenCalled();
  });
  test('training a successful candidate persists the immutable shadow artifact and never activates it', async () => {
    const events = Array.from({ length: 320 }, (_, index) =>
      eventsFor(index, { probability: 0.65 }),
    ).flat();
    const store = repository(events);
    const service = createLearningService(store);
    const status = await service.runLearningCycle({ now: events.at(-1).recordedAt + MINUTE });
    expect(status.lastRun.status).toBe('shadow');
    expect(store.writeModelArtifact).toHaveBeenCalledTimes(1);
    expect(store.activateModelArtifact).not.toHaveBeenCalled();
    expect(store.releaseLearningLease).toHaveBeenCalledTimes(1);
  });
  test('a lease held by another server prevents writes and concurrent calls share one cycle', async () => {
    const store = repository();
    store.acquireLearningLease.mockResolvedValue(false);
    const service = createLearningService(store);
    const first = service.runLearningCycle({ now: START });
    const second = service.runLearningCycle({ now: START });
    expect(first).toBe(second);
    expect((await first).lastRun.status).toBe('busy');
    expect(store.acquireLearningLease).toHaveBeenCalledTimes(1);
    expect(store.writeModelArtifact).not.toHaveBeenCalled();
    expect(store.activateModelArtifact).not.toHaveBeenCalled();
  });
  test('a completed 120-window cohort with one missing prediction can retire and refit instead of waiting forever', async () => {
    const oldCandidate = artifact();
    const events = Array.from({ length: 320 }, (_, index) => {
      const rows = eventsFor(index, { start: START + MINUTE, probability: 0.65 });
      rows[0].shadowPrediction = {
        modelId: oldCandidate.id,
        featureCutoffAt: rows[0].capturedAt,
        aboveProbability: predictOutcomeCandidate(oldCandidate, rows[0].learningFeatures),
      };
      return rows;
    }).flat();
    delete events[0].shadowPrediction;
    const now = events.at(-1).recordedAt + MINUTE;
    const failedShadow = evaluateShadowCandidate(oldCandidate, events, { now });
    expect(failedShadow.evaluationComplete).toBe(true);
    expect(failedShadow.independentWindows).toBe(119);
    expect(failedShadow.eligibleWindows).toBe(120);
    const store = repository(events, [oldCandidate]);
    const service = createLearningService(store);
    const status = await service.runLearningCycle({ now });
    expect(store.writeModelArtifact).toHaveBeenCalledTimes(1);
    expect(status.candidate.id).not.toBe(oldCandidate.id);
    expect(status.candidate.trainedAt).toBe(now);
    expect(store.activateModelArtifact).not.toHaveBeenCalled();
    expect(oldCandidate.activation).toBeUndefined();
  });
  test('failed persistence releases the lease and leaves activation untouched', async () => {
    const store = repository();
    store.getLearningEvidenceRows.mockRejectedValue(new Error('Storage unavailable'));
    const service = createLearningService(store);
    await expect(service.runLearningCycle({ now: START })).rejects.toThrow('Storage unavailable');
    expect(store.releaseLearningLease).toHaveBeenCalledTimes(1);
    expect(store.activateModelArtifact).not.toHaveBeenCalled();
  });
});

describe('prospective shadow promotion', () => {
  function shadowEvents(model, length = 130) {
    return Array.from({ length }, (_, index) => {
      const rows = eventsFor(index, { start: START + MINUTE });
      rows[0].shadowPrediction = {
        modelId: model.id,
        featureCutoffAt: rows[0].capturedAt,
        aboveProbability: predictOutcomeCandidate(model, rows[0].learningFeatures),
      };
      return rows;
    }).flat();
  }
  test('requires newly captured background predictions and rejects retrospective backfill', () => {
    const model = artifact();
    const events = shadowEvents(model);
    for (const event of events)
      if (event.event === 'decision') event.shadowPrediction.featureCutoffAt++;
    const result = evaluateShadowCandidate(model, events, { now: events.at(-1).recordedAt });
    expect(result.eligibleForPromotion).toBe(false);
    expect(result.independentWindows).toBe(0);
  });
  test('manual forecast selection cannot qualify a model for automatic promotion', () => {
    const model = artifact();
    const events = shadowEvents(model);
    events.forEach((event) => {
      event.cohort = 'manual';
    });
    expect(
      evaluateShadowCandidate(model, events, { now: events.at(-1).recordedAt })
        .eligibleForPromotion,
    ).toBe(false);
  });
  test('does not extend a failed prospective cohort until later favorable outcomes make it pass', () => {
    const model = artifact();
    const events = shadowEvents(model, 240);
    for (let index = 1; index < 240; index += 2) {
      events[index].observedPrice = events[index].observedPrice > 100 ? 98 : 102;
      events[index].outcome = events[index].observedPrice > 100 ? 'above' : 'below';
      events[index].kalshiOutcome = {
        ...events[index].kalshiOutcome,
        observedPrice: events[index].observedPrice,
        outcome: events[index].outcome,
        result: events[index].outcome === 'above' ? 'yes' : 'no',
      };
    }
    const first = evaluateShadowCandidate(model, events.slice(0, 240), {
      now: events[239].recordedAt,
    });
    const later = evaluateShadowCandidate(model, events, { now: events.at(-1).recordedAt });
    expect(first.evaluationComplete).toBe(true);
    expect(later.candidate).toEqual(first.candidate);
    expect(later.eligibleForPromotion).toBe(false);
    expect(later.independentWindows).toBe(120);
  });
  test('evaluates matched capture times, current-side benchmark and paired uncertainty before promotion', () => {
    const model = artifact();
    const events = shadowEvents(model);
    const result = evaluateShadowCandidate(model, events, { now: events.at(-1).recordedAt });
    expect(result.eligibleForPromotion).toBe(true);
    expect(result.callCoverage).toBe(1);
    expect(result.candidate.callAccuracy).toBe(1);
    expect(result.benchmark.callAccuracy).toBe(0.5);
    expect(result.uncertainty.accuracyDifference[0]).toBeGreaterThan(0);
    expect(model.activation).toBeUndefined();
  });
  test('missing candidate calls and fabricated candidate probabilities cannot improve its apparent coverage', () => {
    const model = artifact();
    const events = shadowEvents(model);
    delete events[0].shadowPrediction;
    events[2].shadowPrediction.aboveProbability = 0.5;
    const result = evaluateShadowCandidate(model, events, { now: events.at(-1).recordedAt });
    expect(result.eligibleForPromotion).toBe(false);
    expect(result.independentWindows).toBe(118);
    expect(result.callCoverage).toBeLessThan(1);
  });
  test('scores baseline fallbacks at full coverage but requires enough actual learned predictions', () => {
    const model = artifact();
    const events = shadowEvents(model, 120);
    for (let index = 100; index < events.length; index += 2) {
      const decision = events[index];
      decision.capturedAt += 6 * MINUTE;
      decision.inputObservedAt = decision.capturedAt;
      decision.featureCutoffAt = decision.capturedAt;
      decision.recordedAt = decision.capturedAt;
      decision.learningFeatures.featureCutoffAt = decision.capturedAt;
      decision.shadowPrediction.featureCutoffAt = decision.capturedAt;
      decision.shadowPrediction.aboveProbability = predictOutcomeCandidate(
        model,
        decision.learningFeatures,
      );
    }
    const result = evaluateShadowCandidate(model, events, { now: events.at(-1).recordedAt });
    expect(result.callCoverage).toBe(1);
    expect(result.modelUses).toBe(50);
    expect(result.fallbackUses).toBe(70);
    expect(result.eligibleForPromotion).toBe(false);
    expect(result.reasons.join(' ')).toContain('At least 60');
  });
});

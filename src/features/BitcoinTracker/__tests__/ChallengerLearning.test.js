import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { LEARNING_FEATURE_NAMES, LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';
import { logit } from '../utils/learning/statistics.utils';
import {
  LEGACY_CHALLENGER_KINDS as CHALLENGER_KINDS,
  LEGACY_CHALLENGER_REQUIREMENTS as CHALLENGER_REQUIREMENTS,
  LEGACY_CHALLENGER_MODEL_VERSION,
  getChallengerPolicyVersion as getCurrentChallengerPolicyVersion,
  isChallengerArtifact,
  predictChallengerProbability,
} from '../utils/learning/challengerModel.utils';
import {
  trainChallengerCandidate as trainCurrentChallengerCandidate,
  evaluateChallengerCandidate,
  getChallengerTrainingRows,
  evaluateChallengerActiveModel,
} from '../utils/learning/challengerTraining.utils';

const trainChallengerCandidate = (events, labels, options) =>
  trainCurrentChallengerCandidate(events, labels, {
    version: LEGACY_CHALLENGER_MODEL_VERSION,
    ...options,
  });
const getChallengerPolicyVersion = (kind) =>
  getCurrentChallengerPolicyVersion(kind, LEGACY_CHALLENGER_MODEL_VERSION);
const MINUTE = 60_000;
const START = 1_800_000_000_000;
const startOf = (index) => START + index * 17 * MINUTE;
const afterWindow = (index) => startOf(index) + 16 * MINUTE;
const clone = (value) => JSON.parse(JSON.stringify(value));

function recordedWindow(
  index,
  {
    model,
    baseline = 0.8,
    estimate = 0.7,
    production = baseline,
    outcome = index % 2,
    pressure = index % 2 ? 0.7 : -0.7,
    active = false,
    native = true,
  } = {},
) {
  const contract = {
    ticker: `KXBTC15M-CHALLENGER${index}`,
    eventTicker: `KXBTC15M-CHALLENGER${index}`,
    seriesTicker: 'KXBTC15M',
    startsAt: startOf(index),
    expiresAt: startOf(index) + 15 * MINUTE,
    target: 100_000,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    supported: true,
    status: 'active',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const recorder = createResearchRecorder({ recorderId: 'challenger-tests' });
  const events = [];
  for (const minutes of [12, 9, 6, 3, 1]) {
    const now = contract.expiresAt - minutes * MINUTE;
    const featureValues = {
      baselineLogOdds: logit(baseline),
      buyPressure15: pressure,
      buyPressure60: pressure,
      flow15Available: 1,
      flow60Available: 1,
    };
    const features = {
      schemaVersion: LEARNING_FEATURE_VERSION,
      available: true,
      values: LEARNING_FEATURE_NAMES.map((name) => featureValues[name] ?? 0),
      baselineAboveProbability: baseline,
      targetDistance: 0,
      target: contract.target,
      expiresAt: contract.expiresAt,
      featureCutoffAt: now,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      referenceSource: native ? 'cf-brti' : 'coinbase-proxy',
      featureInputSource: native ? 'cf-brti-history' : 'coinbase-candles',
      baselineModelVersion: 'kalshi-brti-average-v2',
      settlementKnownFraction: 0,
    };
    const distribution = {
      available: true,
      referenceSource: features.referenceSource,
      referenceAt: now,
      referencePrice: 100_001,
      minuteVolatility: 0.001,
      expectedSettlementAverage: 100_001,
      settlementStandardDeviation: 100,
      aboveProbability: baseline,
      belowProbability: 1 - baseline,
    };
    const variants = { combined: { ...distribution }, 'settlement-only': { ...distribution } };
    if (model) {
      const variantBase = {
        ...distribution,
        aboveProbability: estimate,
        belowProbability: 1 - estimate,
        policyVersion: getChallengerPolicyVersion(model.kind),
      };
      const predicted = predictChallengerProbability(model, {
        baseForecast: {
          ...distribution,
          target: contract.target,
          expiresAt: contract.expiresAt,
          researchVariants: variants,
        },
        learningFeatures: features,
        input: { now },
        windowStartAt: contract.startsAt,
        variantBase,
      });
      variants[model.variantName] = {
        ...variantBase,
        aboveProbability: predicted,
        belowProbability: 1 - predicted,
        modelId: model.id,
        featureCutoffAt: now,
      };
      if (active) production = predicted;
    }
    const forecast = {
      available: true,
      aboveProbability: production,
      belowProbability: 1 - production,
      direction: production > 0.5 ? 'above' : 'below',
      modelVersion: features.baselineModelVersion,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      learningFeatures: features,
      kalshi: {
        referenceSource: features.referenceSource,
        referencePrice: 100_001,
        referenceAt: now,
        referenceReceivedAt: now,
        priceDynamicsSource: features.featureInputSource,
        observedSampleCount: 0,
      },
      ...(active
        ? {
            learning: {
              applied: true,
              modelId: model.id,
              aboveProbability: production,
              baselineAboveProbability: baseline,
              featureVersion: features.schemaVersion,
              calibrationVersion: model.policyVersion,
              trainingCutoffAt: model.trainingCutoffAt,
            },
          }
        : {}),
      researchExperiment: {
        version: 'kalshi-ablation-v2',
        capturedAt: now,
        marketTicker: contract.ticker,
        target: contract.target,
        expiresAt: contract.expiresAt,
        variants,
        production: {
          available: true,
          aboveProbability: production,
          belowProbability: 1 - production,
          modelVersion: features.baselineModelVersion,
        },
      },
    };
    const result = recorder.advance({
      now,
      ticker: { price: 100_001, time: now, receivedAt: now },
      markets: [{ ...contract, receivedAt: now }],
      getEstimate: () => forecast,
    });
    events.push(...result.rows);
  }
  const resolvedAt = contract.expiresAt + 1000;
  events.push(
    ...recorder.advance({
      now: resolvedAt,
      markets: [
        {
          ...contract,
          status: 'finalized',
          result: outcome ? 'yes' : 'no',
          settlementPrice: outcome ? 100_002 : 99_998,
          receivedAt: resolvedAt,
        },
      ],
      getEstimate: () => null,
    }).rows,
  );
  return events;
}
const windowSet = (count, first = 0, options = {}) =>
  Array.from({ length: count }, (_, offset) =>
    recordedWindow(
      first + offset,
      typeof options === 'function' ? options(first + offset) : options,
    ),
  ).flat();
function labelsFor(events) {
  return events
    .filter((row) => row.event === 'decision')
    .map((row) => {
      const pressure = row.learningFeatures.values[LEARNING_FEATURE_NAMES.indexOf('buyPressure60')];
      const dueAt = row.capturedAt + MINUTE;
      const price = row.spot * Math.exp(pressure * 0.001);
      return {
        version: 'brti-forward-label-v1',
        labelId: `${row.eventId}:forward:60`,
        snapshotId: row.eventId,
        forecastId: row.forecastId,
        status: 'observed',
        capturedAt: row.capturedAt,
        horizonSeconds: 60,
        dueAt,
        recordedAt: dueAt + 1000,
        reference: {
          time: row.quoteTime,
          price: row.spot,
          receivedAt: row.receivedAt,
          source: 'cf-brti',
        },
        reading: { time: dueAt, price, receivedAt: dueAt },
        logReturn: Math.log(price / row.spot),
      };
    });
}
function trained(kind = 'reduced-pressure') {
  const events = windowSet(60);
  return trainChallengerCandidate(events, labelsFor(events), { kind, now: afterWindow(59) });
}

test.each(CHALLENGER_KINDS)('%s freezes only compatible completed native training data', (kind) => {
  const result = trained(kind);
  expect(result.status).toBe('shadow');
  expect(result.counts.independentWindows).toBe(60);
  expect(isChallengerArtifact(result.artifact)).toBe(true);
  expect(result.artifact.variantPolicyVersion).toBe(getChallengerPolicyVersion(kind));
  expect(
    evaluateChallengerCandidate(result.artifact, windowSet(60), { now: afterWindow(59) }),
  ).toMatchObject({ eligibleForPromotion: false, eligibleWindows: 0 });
});

test('forward regression learns actual later returns and excludes unavailable, future, or mismatched labels', () => {
  const events = windowSet(60);
  const labels = labelsFor(events);
  const model = trained('forward-pressure').artifact;
  expect(model.model.coefficients[1]).toBeGreaterThan(0);
  const reversed = labels.map((label) => ({
    ...label,
    reading: { ...label.reading, price: label.reference.price * Math.exp(-label.logReturn) },
    logReturn: -label.logReturn,
  }));
  const negative = trainChallengerCandidate(events, reversed, {
    kind: 'forward-pressure',
    now: afterWindow(59),
  });
  expect(negative.artifact.model.coefficients[1]).toBeLessThan(0);
  for (const bad of [
    [],
    labels.map((label) => ({ ...label, recordedAt: afterWindow(61) })),
    labels.map((label) => ({ ...label, snapshotId: 'different' })),
    labels.map((label) => ({ ...label, reading: { ...label.reading, time: label.dueAt + 1000 } })),
  ]) {
    expect(
      getChallengerTrainingRows(events, bad, 'forward-pressure', afterWindow(59)).counts
        .independentWindows,
    ).toBe(0);
  }
});

test('source or policy revisions cannot reuse a trained artifact and fitted influence is bounded', () => {
  expect(
    trainChallengerCandidate(windowSet(60, 0, { native: false }), [], {
      kind: 'reversal',
      now: afterWindow(59),
    }).artifact,
  ).toBeNull();
  const model = trained('forward-pressure').artifact;
  const future = recordedWindow(60, { model, baseline: 0.5 });
  for (const row of future.filter((event) => event.event === 'decision')) {
    const predicted = row.researchExperiment.variants[model.variantName].aboveProbability;
    expect(predicted).toBeGreaterThanOrEqual(0.45);
    expect(predicted).toBeLessThanOrEqual(0.55);
  }
  expect(isChallengerArtifact({ ...model, variantPolicyVersion: 'old-policy' })).toBe(false);
  const row = future[0];
  const context = {
    baseForecast: {
      available: true,
      aboveProbability: 0.5,
      target: row.target,
      expiresAt: row.expiresAt,
      researchVariants: row.researchExperiment.variants,
    },
    learningFeatures: row.learningFeatures,
    input: { now: row.capturedAt },
    windowStartAt: row.windowStartAt,
  };
  expect(predictChallengerProbability({ ...model, retirement: {} }, context)).toBeNull();
  expect(
    predictChallengerProbability(model, { ...context, windowStartAt: model.trainedAt }),
  ).toBeNull();
  expect(
    predictChallengerProbability(model, {
      ...context,
      baseForecast: { ...context.baseForecast, target: 1 },
    }),
  ).toBeNull();
});

test('the complete first future cohort must beat both baseline and recorded production', () => {
  const model = trained().artifact;
  const future = windowSet(60, 60, { model });
  const result = evaluateChallengerCandidate(model, future, { now: afterWindow(119) });
  expect(result).toMatchObject({
    eligibleForPromotion: true,
    evaluationComplete: true,
    independentWindows: 60,
    modelUses: 60,
  });
  expect(result.uncertainty.confidenceLevel).toBe(0.99);
  const betterProduction = windowSet(60, 60, { model, production: 0.5 });
  const rejected = evaluateChallengerCandidate(model, betterProduction, { now: afterWindow(119) });
  expect(rejected.eligibleForPromotion).toBe(false);
  expect(rejected.reasons.join(' ')).toMatch(/production/);
  const missing = clone(future);
  missing
    .filter((row) => row.event === 'decision')
    .slice(0, 5)
    .forEach((row) => {
      delete row.researchExperiment.variants[model.variantName];
    });
  const laterWinners = windowSet(30, 120, { model, estimate: 0.5 });
  expect(
    evaluateChallengerCandidate(model, [...missing, ...laterWinners], { now: afterWindow(149) }),
  ).toMatchObject({
    eligibleForPromotion: false,
    evaluationComplete: true,
    independentWindows: 59,
  });
});

test.each(['version', 'modelId', 'featureCutoffAt', 'policyVersion', 'referencePrice'])(
  'tampered %s never qualifies as a recorded candidate',
  (field) => {
    const model = trained().artifact;
    const events = windowSet(60, 60, { model });
    for (const row of events.filter((event) => event.event === 'decision')) {
      if (field === 'version') row.researchExperiment.version = 'kalshi-ablation-v1';
      else row.researchExperiment.variants[model.variantName][field] = 'wrong';
    }
    expect(evaluateChallengerCandidate(model, events, { now: afterWindow(119) })).toMatchObject({
      eligibleForPromotion: false,
      independentWindows: 0,
      evaluationComplete: true,
    });
  },
);

test('active monitoring suppresses deteriorated production without changing saved calls', () => {
  const artifact = trained().artifact;
  const model = {
    ...artifact,
    activation: {
      modelId: artifact.id,
      activatedAt: afterWindow(60),
      shadowEvaluation: { modelId: artifact.id, eligibleForPromotion: true },
    },
  };
  const events = windowSet(40, 61, { model, baseline: 0.5, estimate: 0.8, active: true });
  const before = JSON.stringify(events);
  expect(evaluateChallengerActiveModel(model, events, { now: afterWindow(100) }).status).toBe(
    'disabled',
  );
  expect(JSON.stringify(events)).toBe(before);
  expect(CHALLENGER_REQUIREMENTS.maximumProbabilityAdjustment).toBe(0.05);
});

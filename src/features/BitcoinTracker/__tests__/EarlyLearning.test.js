import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { LEARNING_FEATURE_NAMES, LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';
import { logit } from '../utils/learning/statistics.utils';
import {
  EARLY_MODEL_VERSION,
  EARLY_CALIBRATION_VERSION,
  EARLY_LEARNING_REQUIREMENTS,
  isEarlyModelArtifact,
  isWithinEarlyModelDomain,
  predictEarlyCandidate,
} from '../utils/learning/earlyModel.utils';
import {
  trainEarlyCandidate,
  evaluateEarlyShadowCandidate,
  evaluateEarlyActiveModel,
} from '../utils/learning/earlyTraining.utils';

const MINUTE = 60_000;
const START = 1_800_000_000_000;
const startOf = (index) => START + index * 17 * MINUTE;
const afterWindow = (index) => startOf(index) + 16 * MINUTE;
const BASELINE_VERSION = 'kalshi-brti-average-v2';

function recordedWindow(
  index,
  {
    probability = 0.8,
    outcome = index % 2,
    model = null,
    active = false,
    native = true,
    targetDistance = 0,
  } = {},
) {
  const contract = {
    ticker: `KXBTC15M-EARLY${index}`,
    eventTicker: `KXBTC15M-EARLY${index}`,
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
  const recorder = createResearchRecorder({ recorderId: 'early-tests' });
  const events = [];
  for (const minutes of [12, 9, 6, 3, 1]) {
    const now = contract.expiresAt - minutes * MINUTE;
    const learningFeatures = {
      schemaVersion: LEARNING_FEATURE_VERSION,
      available: true,
      values: LEARNING_FEATURE_NAMES.map((_, feature) => (feature === 0 ? logit(probability) : 0)),
      baselineAboveProbability: probability,
      targetDistance,
      target: contract.target,
      expiresAt: contract.expiresAt,
      featureCutoffAt: now,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      referenceSource: native ? 'cf-brti' : 'coinbase-proxy',
      featureInputSource: native ? 'cf-brti-history' : 'coinbase-candles',
      baselineModelVersion: BASELINE_VERSION,
      settlementKnownFraction: 0,
    };
    const candidate = model ? predictEarlyCandidate(model, learningFeatures) : null;
    const adjusted = active && candidate !== null ? candidate : probability;
    const hasCorrection = active && candidate !== null && Math.abs(candidate - probability) > 1e-9;
    const estimate = {
      available: true,
      aboveProbability: adjusted,
      belowProbability: 1 - adjusted,
      direction: adjusted > 0.5 ? 'above' : adjusted < 0.5 ? 'below' : 'neutral',
      modelVersion: hasCorrection ? EARLY_MODEL_VERSION : BASELINE_VERSION,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      learningFeatures,
      kalshi: {
        referenceSource: learningFeatures.referenceSource,
        priceDynamicsSource: learningFeatures.featureInputSource,
        observedSampleCount: 0,
      },
      ...(hasCorrection
        ? {
            learning: {
              applied: true,
              modelId: model.id,
              aboveProbability: adjusted,
              baselineAboveProbability: probability,
              featureVersion: LEARNING_FEATURE_VERSION,
              calibrationVersion: EARLY_CALIBRATION_VERSION,
              trainingCutoffAt: model.trainingCutoffAt,
            },
          }
        : {}),
    };
    const result = recorder.advance({
      now,
      ticker: { price: 100_001, time: now, receivedAt: now },
      markets: [{ ...contract, receivedAt: now }],
      getEstimate: () => estimate,
    });
    events.push(
      ...result.rows.map((row) =>
        row.event === 'decision' && model && !active
          ? {
              ...row,
              earlyShadowPrediction: {
                modelId: model.id,
                featureCutoffAt: now,
                aboveProbability: candidate,
              },
            }
          : row,
      ),
    );
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
function trained() {
  return trainEarlyCandidate(windowSet(40), { now: afterWindow(39) }).artifact;
}
const clone = (value) => JSON.parse(JSON.stringify(value));

test('40 independent windows create a shadow-only two-parameter correction without retrospective promotion', () => {
  const result = trainEarlyCandidate(windowSet(40), { now: afterWindow(39) });
  expect(result.status).toBe('shadow');
  expect(result.counts).toMatchObject({
    training: 40,
    independentWindows: 40,
    trainingCheckpoints: 200,
    classes: { above: 20, below: 20 },
  });
  expect(result.artifact).toMatchObject({
    version: EARLY_MODEL_VERSION,
    status: 'shadow',
    model: { indexes: [0], trainingRows: 200 },
    calibration: { version: EARLY_CALIBRATION_VERSION },
    requirements: EARLY_LEARNING_REQUIREMENTS,
  });
  expect(result.artifact.activation).toBeUndefined();
  expect(result.artifact.model.trainingWeight).toBeCloseTo(40, 10);
  expect(result.artifact.model.coefficients).toHaveLength(2);
  expect(result.artifact.model.coefficients[1]).toBeGreaterThanOrEqual(0);
  expect(isEarlyModelArtifact(result.artifact)).toBe(true);
});

test('duplicate collectors and checkpoints do not inflate independent evidence or fitting weights', () => {
  const events = windowSet(40);
  const duplicateCollector = events.map((event) => ({
    ...event,
    eventId: `duplicate-${event.eventId}`,
    forecastId: `duplicate-${event.forecastId}`,
  }));
  const ordinary = trainEarlyCandidate(events, { now: afterWindow(39) });
  const duplicated = trainEarlyCandidate([...events, ...events, ...duplicateCollector], {
    now: afterWindow(39),
  });
  expect(duplicated.counts.independentWindows).toBe(40);
  expect(duplicated.artifact.model.trainingWeight).toBeCloseTo(40, 10);
  expect(duplicated.artifact.model.trainingRows).toBe(200);
  expect(duplicated.artifact.model.coefficients).toEqual(ordinary.artifact.model.coefficients);
});

test('fewer than 40 resolved groups or fewer than eight of either outcome cannot fit', () => {
  expect(trainEarlyCandidate(windowSet(39), { now: afterWindow(39) }).artifact).toBeNull();
  const imbalanced = windowSet(40, 0, (index) => ({ outcome: index < 7 ? 1 : 0 }));
  expect(trainEarlyCandidate(imbalanced, { now: afterWindow(39) })).toMatchObject({
    status: 'insufficient-data',
    artifact: null,
    counts: { classes: { above: 7, below: 33 } },
  });
});

test('future decisions, late outcome publication and different input pipelines cannot leak into fitting', () => {
  const original = windowSet(40);
  const now = afterWindow(39);
  const fit = trainEarlyCandidate(original, { now });
  const future = trainEarlyCandidate([...original, ...windowSet(40, 40)], { now });
  expect(future.artifact).toEqual(fit.artifact);
  const late = original.map((event) =>
    event.event === 'outcome' && event.kalshiMarket.ticker === 'KXBTC15M-EARLY39'
      ? { ...event, recordedAt: afterWindow(45) }
      : event,
  );
  expect(trainEarlyCandidate(late, { now })).toMatchObject({
    artifact: null,
    counts: { training: 39 },
  });
  const mixed = [...windowSet(20), ...windowSet(20, 20, { native: false })];
  expect(trainEarlyCandidate(mixed, { now })).toMatchObject({
    artifact: null,
    counts: { training: 20 },
  });
});

test('the negative unconstrained slope is replaced with a monotone constant correction', () => {
  const data = windowSet(40, 0, (index) => ({ probability: index % 2 ? 0.2 : 0.8 }));
  const model = trainEarlyCandidate(data, { now: afterWindow(39) }).artifact;
  expect(model.model.coefficients[1]).toBe(0);
  expect(model.model.coefficients[0]).toBeCloseTo(0, 8);
});

test('the applied prediction is blended and capped at five percentage points', () => {
  const model = trained();
  const snapshot = recordedWindow(40)[0].learningFeatures;
  const probability = predictEarlyCandidate(model, snapshot);
  expect(probability).toBeCloseTo(0.75, 10);
  expect(Math.abs(probability - snapshot.baselineAboveProbability)).toBeLessThanOrEqual(
    0.05 + 1e-12,
  );
  const tampered = clone(model);
  tampered.requirements.maximumProbabilityAdjustment = 0.3;
  expect(isEarlyModelArtifact(tampered)).toBe(false);
  expect(predictEarlyCandidate(tampered, snapshot)).toBeNull();
});

test('invalid feature snapshots and forecasts before training are rejected', () => {
  const model = trained();
  const snapshot = recordedWindow(40)[0].learningFeatures;
  expect(predictEarlyCandidate(model, { ...snapshot, values: [0] })).toBeNull();
  const earlier = recordedWindow(20)[0].learningFeatures;
  expect(predictEarlyCandidate(model, earlier)).toBeNull();
  const negative = clone(model);
  negative.model.coefficients[1] = -1;
  expect(isEarlyModelArtifact(negative)).toBe(false);
});

test('unsupported probabilities, distances, pipelines or observed settlement portions retain baseline', () => {
  const model = trained();
  const snapshot = recordedWindow(40)[0].learningFeatures;
  for (const change of [
    { baselineAboveProbability: 0.9 },
    { targetDistance: 2 },
    { baselineModelVersion: 'future-model-v9' },
    { referenceSource: 'coinbase-proxy', featureInputSource: 'coinbase-candles' },
    { settlementKnownFraction: 0.5 },
  ]) {
    const input = { ...snapshot, ...change };
    expect(predictEarlyCandidate(model, input)).toBe(input.baselineAboveProbability);
  }
});

test('unused optional feed changes do not block the correction and continuous trained horizons allow clock grace', () => {
  const model = trained();
  const snapshot = recordedWindow(40)[0].learningFeatures;
  const withDepth = { ...snapshot, values: [...snapshot.values] };
  withDepth.values[22] = 1;
  expect(predictEarlyCandidate(model, withDepth)).toBe(predictEarlyCandidate(model, snapshot));
  expect(
    isWithinEarlyModelDomain(model, {
      ...snapshot,
      featureCutoffAt: snapshot.expiresAt - 8.5 * MINUTE,
    }),
  ).toBe(true);
  expect(
    isWithinEarlyModelDomain(model, {
      ...snapshot,
      featureCutoffAt: snapshot.expiresAt - 12 * MINUTE - 4000,
    }),
  ).toBe(true);
  expect(
    isWithinEarlyModelDomain(model, {
      ...snapshot,
      featureCutoffAt: snapshot.expiresAt - 13 * MINUTE,
    }),
  ).toBe(false);
});

test('only 40 later recorded capped predictions with paired Brier improvement can promote', () => {
  const model = trained();
  const events = windowSet(40, 40, { model });
  const evaluation = evaluateEarlyShadowCandidate(model, events, { now: afterWindow(79) });
  expect(evaluation).toMatchObject({
    status: 'ready',
    evaluationComplete: true,
    eligibleForPromotion: true,
    independentWindows: 40,
    eligibleWindows: 40,
    modelUses: 40,
    callCoverage: 1,
  });
  expect(evaluation.candidate.callAccuracy).toBe(evaluation.baseline.callAccuracy);
  expect(evaluation.uncertainty.brierDifference[1]).toBeLessThan(0);
  expect(evaluation.baseline.brier).toBeCloseTo(0.34, 8);
  expect(evaluation.candidate.brier).toBeCloseTo(0.3125, 8);
});

test('partial shadow performance is descriptive and cannot claim promotion or an uncertainty pass', () => {
  const model = trained();
  const evaluation = evaluateEarlyShadowCandidate(model, windowSet(10, 40, { model }), {
    now: afterWindow(49),
  });
  expect(evaluation).toMatchObject({
    status: 'insufficient-data',
    eligibleForPromotion: false,
    evaluationComplete: false,
    independentWindows: 10,
    modelUses: 10,
    uncertainty: null,
  });
  expect(evaluation.candidate.brier).toBeLessThan(evaluation.baseline.brier);
});

test('missing shadow predictions cannot be replaced by later wins or reconstructed predictions', () => {
  const model = trained();
  const events = windowSet(40, 40, { model }).map((event) =>
    event.kalshiMarket.ticker === 'KXBTC15M-EARLY40' && event.event === 'decision'
      ? { ...event, earlyShadowPrediction: null }
      : event,
  );
  const early = evaluateEarlyShadowCandidate(model, events, { now: afterWindow(79) });
  const later = evaluateEarlyShadowCandidate(model, [...events, ...windowSet(40, 80, { model })], {
    now: afterWindow(119),
  });
  expect(early).toMatchObject({
    evaluationComplete: true,
    eligibleForPromotion: false,
    independentWindows: 39,
    eligibleWindows: 40,
  });
  expect(later.independentWindows).toBe(39);
  expect(later.eligibleForPromotion).toBe(false);
});

test('a delayed first official outcome holds its original shadow slot instead of admitting later resolved windows', () => {
  const model = trained();
  const events = windowSet(41, 40, { model }).map((event) =>
    event.event === 'outcome' && event.kalshiMarket.ticker === 'KXBTC15M-EARLY40'
      ? { ...event, recordedAt: afterWindow(90) }
      : event,
  );
  const pending = evaluateEarlyShadowCandidate(model, events, { now: afterWindow(80) });
  expect(pending).toMatchObject({
    status: 'insufficient-data',
    eligibleForPromotion: false,
    evaluationComplete: false,
    eligibleWindows: 40,
    independentWindows: 39,
    resolvedWindows: 39,
  });
  const complete = evaluateEarlyShadowCandidate(model, events, { now: afterWindow(90) });
  expect(complete).toMatchObject({
    status: 'ready',
    eligibleForPromotion: true,
    evaluationComplete: true,
    independentWindows: 40,
    firstWindowAt: startOf(40),
    lastDeadlineAt: startOf(79) + 15 * MINUTE,
  });
});

test.each(['unobserved', 'conflict'])(
  'a terminal %s record fails the fixed cohort instead of waiting forever or replacing its slot',
  (failure) => {
    const model = trained();
    let events = windowSet(41, 40, { model });
    if (failure === 'unobserved') {
      events = events.map((event) =>
        event.event === 'outcome' && event.kalshiMarket.ticker === 'KXBTC15M-EARLY40'
          ? { ...event, outcomeStatus: 'unobserved' }
          : event,
      );
    } else {
      const conflicting = events
        .filter(
          (event) => event.event === 'decision' && event.kalshiMarket.ticker === 'KXBTC15M-EARLY40',
        )
        .map((event) => ({ ...event, aboveProbability: 0.6, belowProbability: 0.4 }));
      events.push(...conflicting);
    }
    const evaluation = evaluateEarlyShadowCandidate(model, events, { now: afterWindow(80) });
    expect(evaluation).toMatchObject({
      status: 'shadow',
      evaluationComplete: true,
      eligibleForPromotion: false,
      eligibleWindows: 40,
      independentWindows: 39,
    });
    expect(evaluation.reasons[0]).toMatch(/conflicting evidence or a terminal unobserved outcome/);
  },
);

test('a refit cannot inherit shadow scores recorded for a different model or capture time', () => {
  const model = trained();
  const events = windowSet(40, 40, { model });
  const renamed = { ...model, id: `${model.id}-refit` };
  expect(
    evaluateEarlyShadowCandidate(renamed, events, { now: afterWindow(79) }).independentWindows,
  ).toBe(0);
  const altered = events.map((event) =>
    event.event === 'decision'
      ? {
          ...event,
          earlyShadowPrediction: {
            ...event.earlyShadowPrediction,
            featureCutoffAt: event.capturedAt + 1,
          },
        }
      : event,
  );
  expect(
    evaluateEarlyShadowCandidate(model, altered, { now: afterWindow(79) }).independentWindows,
  ).toBe(0);
});

test('shadow promotion rejects single-class cohorts, too few actual corrections and worse Brier outcomes', () => {
  const model = trained();
  const singleClass = evaluateEarlyShadowCandidate(
    model,
    windowSet(40, 40, { model, outcome: 1 }),
    { now: afterWindow(79) },
  );
  expect(singleClass.eligibleForPromotion).toBe(false);
  const domainFallback = evaluateEarlyShadowCandidate(
    model,
    windowSet(40, 40, (index) => ({ model, targetDistance: index < 59 ? 0 : 3 })),
    { now: afterWindow(79) },
  );
  expect(domainFallback).toMatchObject({ modelUses: 19, eligibleForPromotion: false });
  const worse = evaluateEarlyShadowCandidate(
    model,
    windowSet(40, 40, (index) => ({ model, outcome: index < 72 ? 1 : 0 })),
    { now: afterWindow(79) },
  );
  expect(worse.eligibleForPromotion).toBe(false);
  expect(worse.candidate.brier).toBeGreaterThan(worse.baseline.brier);
});

function activatedModel() {
  const model = trained();
  return {
    ...model,
    activation: {
      modelId: model.id,
      activatedAt: afterWindow(79),
      shadowEvaluation: { eligibleForPromotion: true },
    },
  };
}

test('monitoring needs real matching probabilities, not missing records or a different model', () => {
  const model = activatedModel();
  const events = windowSet(40, 80, { model, active: true });
  expect(evaluateEarlyActiveModel(model, events, { now: afterWindow(119) }).status).toBe('healthy');
  const missing = events.map((event) =>
    event.event === 'decision' ? { ...event, learning: null } : event,
  );
  expect(evaluateEarlyActiveModel(model, missing, { now: afterWindow(119) })).toMatchObject({
    status: 'monitoring',
    independentWindows: 0,
  });
  const wrong = events.map((event) =>
    event.event === 'decision'
      ? { ...event, learning: { ...event.learning, modelId: 'other-model' } }
      : event,
  );
  expect(evaluateEarlyActiveModel(model, wrong, { now: afterWindow(119) }).status).toBe(
    'monitoring',
  );
});

test('monitoring scores legitimate domain fallbacks but requires at least 20 actual learned uses', () => {
  const model = activatedModel();
  const enough = windowSet(40, 80, (index) => ({
    model,
    active: true,
    targetDistance: index < 100 ? 0 : 3,
  }));
  expect(evaluateEarlyActiveModel(model, enough, { now: afterWindow(119) })).toMatchObject({
    status: 'healthy',
    modelUses: 20,
    independentWindows: 40,
  });
  const tooFew = windowSet(40, 80, (index) => ({
    model,
    active: true,
    targetDistance: index < 99 ? 0 : 3,
  }));
  expect(evaluateEarlyActiveModel(model, tooFew, { now: afterWindow(119) })).toMatchObject({
    status: 'monitoring',
    modelUses: 19,
  });
});

test('latest active windows disable a deteriorating correction without hiding a one-sided losing regime', () => {
  const model = activatedModel();
  const healthy = windowSet(40, 80, { model, active: true });
  const deterioration = windowSet(40, 120, { model, active: true, outcome: 1 });
  const result = evaluateEarlyActiveModel(model, [...healthy, ...deterioration], {
    now: afterWindow(159),
  });
  expect(result).toMatchObject({ status: 'disabled', independentWindows: 40 });
  expect(result.firstWindowAt).toBe(startOf(120));
  expect(result.candidate.brier - result.baseline.brier).toBeGreaterThan(0.005);
});

test('the accuracy deterioration limit can disable a correction even below the Brier deterioration limit', () => {
  const model = activatedModel();
  model.applicability.minimumBaselineProbability = 0;
  model.applicability.maximumBaselineProbability = 1;
  model.model.coefficients = [logit(0.4991), 0];
  const result = evaluateEarlyActiveModel(
    model,
    windowSet(40, 80, { model, active: true, probability: 0.5001, outcome: 1 }),
    { now: afterWindow(119) },
  );
  expect(result.status).toBe('disabled');
  expect(result.candidate.brier - result.baseline.brier).toBeLessThan(0.005);
  expect(result.reasons).toEqual([
    'Recent directional accuracy is more than five percentage points below the baseline.',
  ]);
});

test('retirement prevents new predictions while historical pre-retirement scores stay reproducible', () => {
  const model = { ...trained(), retirement: { retiredAt: startOf(50), reason: 'Shadow failed.' } };
  expect(isEarlyModelArtifact(model)).toBe(true);
  expect(predictEarlyCandidate(model, recordedWindow(40)[0].learningFeatures)).not.toBeNull();
  expect(predictEarlyCandidate(model, recordedWindow(60)[0].learningFeatures)).toBeNull();
});

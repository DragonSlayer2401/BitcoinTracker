import { createResearchRecorder } from '../../utils/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../../utils/kalshi/contract.utils';
import {
  LEARNING_FEATURE_NAMES,
  LEARNING_FEATURE_VERSION,
} from '../../utils/learning/features.utils';
import { logit } from '../../utils/learning/statistics.utils';
import {
  getChallengerPolicyVersion,
  predictChallengerProbability,
} from '../../utils/learning/challengerModel.utils';
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
    estimateByCheckpoint = {},
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
    for (const kind of ['reduced-pressure', 'fast-decay', 'market-blend']) {
      variants[kind] = { ...distribution, policyVersion: getChallengerPolicyVersion(kind) };
    }
    if (model) {
      const variantBase = {
        ...distribution,
        aboveProbability: estimateByCheckpoint[minutes] ?? estimate,
        belowProbability: 1 - (estimateByCheckpoint[minutes] ?? estimate),
        policyVersion: getChallengerPolicyVersion(model.kind, model.version),
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
        rawAboveProbability: estimateByCheckpoint[minutes] ?? estimate,
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
        version: 'kalshi-ablation-v3',
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

export { MINUTE, START, startOf, afterWindow, clone, recordedWindow, windowSet, labelsFor };

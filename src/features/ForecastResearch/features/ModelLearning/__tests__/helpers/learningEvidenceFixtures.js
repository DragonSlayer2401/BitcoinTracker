import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';
import { getLearningFeatureSchema, LEARNING_FEATURE_VERSION } from '../../utils/features.utils';
import { predictOutcomeCandidate } from '../../utils/model.utils';

export const learningStart = Date.UTC(2026, 9, 1, 0);
export const learningInterval = 20 * 60_000;

// These are archived observations, the external input to a learning cycle. A
// separate official outcome is attached only after each contract has closed.
export const createLearningEventPair = ({
  id,
  startsAt = learningStart,
  checkpointMinutes = 9,
  baselineProbability = 0.6,
  outcome = 'yes',
  spot = baselineProbability >= 0.5 ? 50_050 : 49_950,
  targetDistance = baselineProbability >= 0.5 ? 1 : -1,
  pipeline = {},
  schemaVersion = LEARNING_FEATURE_VERSION,
  values,
  featureOverrides = {},
  model,
  phase = 'training',
} = {}) => {
  const expiresAt = startsAt + 900_000;
  const capturedAt = expiresAt - checkpointMinutes * 60_000;
  const forecastId = id ?? `learning-${startsAt}-${checkpointMinutes}`;
  const result = outcome === 'yes' || outcome === 1 ? 'yes' : 'no';
  const kalshiMarket = {
    ticker: `KXBTC15M-${startsAt}-15`,
    eventTicker: `KXBTC15M-${startsAt}`,
    seriesTicker: 'KXBTC15M',
    startsAt,
    expiresAt,
    target: 50_000,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const featureValues = Array(getLearningFeatureSchema(schemaVersion).names.length).fill(0);
  featureValues[0] = Math.log(baselineProbability / (1 - baselineProbability));
  featureValues[1] = targetDistance;
  featureValues[2] = checkpointMinutes / 15;
  const learningFeatures = {
    available: true,
    schemaVersion,
    baselineModelVersion: 'kalshi-brti-average-v3',
    referenceSource: 'cf-brti',
    featureInputSource: 'cf-brti-history',
    ...pipeline,
    values: values ?? featureValues,
    baselineAboveProbability: baselineProbability,
    targetDistance,
    target: 50_000,
    expiresAt,
    featureCutoffAt: capturedAt,
    settlementKnownFraction: 0,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    ...featureOverrides,
  };
  const predicted = model ? predictOutcomeCandidate(model, learningFeatures) : null;
  const probability = phase === 'active' ? predicted : baselineProbability;
  const common = {
    schemaVersion: 1,
    forecastId,
    cohort: 'kalshi-background',
    source: 'Kalshi KXBTC15M / CF Benchmarks BRTI',
    windowStartAt: startsAt,
    expiresAt,
    target: 50_000,
    kalshiMarket,
    checkpointMinutes,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const decision = {
    ...common,
    eventId: `${forecastId}:decision:pending`,
    event: 'decision',
    decision: 'pending',
    sessionOrigin: 'new',
    recordedAt: capturedAt,
    capturedAt,
    inputObservedAt: capturedAt,
    featureCutoffAt: capturedAt,
    inputStatus: 'captured',
    spot,
    aboveProbability: probability,
    belowProbability: probability === null ? null : 1 - probability,
    modelVersion: phase === 'active' ? model.version : learningFeatures.baselineModelVersion,
    learningFeatures,
    referenceSource: learningFeatures.referenceSource,
  };
  if (phase === 'shadow')
    decision[
      model.version === 'outcome-early-kalshi-v1' ? 'earlyShadowPrediction' : 'shadowPrediction'
    ] = {
      modelId: model.id,
      aboveProbability: predicted,
      featureCutoffAt: capturedAt,
    };
  if (phase === 'active')
    decision.learning = {
      applied: true,
      modelId: model.id,
      aboveProbability: probability,
      baselineAboveProbability: baselineProbability,
    };
  const observedPrice = result === 'yes' ? 50_100 : 49_900;
  const officialOutcome = {
    status: 'observed',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    marketTicker: kalshiMarket.ticker,
    target: 50_000,
    expiresAt,
    observedAt: expiresAt,
    observedPrice,
    outcome: result === 'yes' ? 'above' : 'below',
    result,
    confirmedThrough: expiresAt,
    settledAt: expiresAt,
    comparison: 'greater_or_equal',
    roundDigits: 2,
  };
  return [
    decision,
    {
      ...common,
      eventId: `${forecastId}:outcome:resolved`,
      event: 'outcome',
      decision: 'resolved',
      recordedAt: expiresAt,
      inputStatus: 'outcome-only',
      outcomeStatus: 'observed',
      observedPrice,
      observedAt: expiresAt,
      confirmedThrough: expiresAt,
      outcome: officialOutcome.outcome,
      kalshiOutcome: officialOutcome,
    },
  ];
};

export const createLearningEvents = ({
  count = 40,
  startAt = learningStart,
  interval = learningInterval,
  probabilityForIndex = (index) => (index % 2 ? 0.4 : 0.6),
  outcomeForIndex = (index) => (index % 2 ? 'no' : 'yes'),
  spotForIndex,
  valuesForIndex,
  featuresForIndex,
  ...options
} = {}) =>
  Array.from({ length: count }, (_, index) => {
    const pair = createLearningEventPair({
      ...options,
      startsAt: startAt + index * interval,
      baselineProbability: probabilityForIndex(index),
      outcome: outcomeForIndex(index),
      ...(spotForIndex ? { spot: spotForIndex(index) } : {}),
      ...(featuresForIndex ? { featureOverrides: featuresForIndex(index) } : {}),
    });
    if (!valuesForIndex) return pair;
    return createLearningEventPair({
      ...options,
      startsAt: startAt + index * interval,
      baselineProbability: probabilityForIndex(index),
      outcome: outcomeForIndex(index),
      ...(spotForIndex ? { spot: spotForIndex(index) } : {}),
      ...(featuresForIndex ? { featureOverrides: featuresForIndex(index) } : {}),
      values: valuesForIndex(index, pair[0].learningFeatures.values),
    });
  }).flat();

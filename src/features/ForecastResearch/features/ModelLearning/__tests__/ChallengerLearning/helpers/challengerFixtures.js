import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';
import {
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_POLICY_VERSION,
  CHALLENGER_REQUIREMENTS,
  getChallengerPolicyVersion,
} from '../../../utils/challengerModel.utils';
import { CHALLENGER_CALIBRATION_VERSION } from '../../../utils/challengerCheckpoint.utils';
import { LEARNING_FEATURE_VERSION } from '../../../utils/features.utils';
import { RESEARCH_EXPERIMENT_V4 } from '../../../../../utils/researchVariantConfig.utils';
import { createLearningEvents } from '../../helpers/learningEvidenceFixtures';

export const contractDuration = 900_000;
export const trainedAt = Date.UTC(2026, 9, 5, 12);

// A previously frozen artifact is an archive input. Its fixed policy identity,
// timing and checkpoint calibration are consumed by the real selection and evaluator.
export const createChallenger = ({ enrolled = false, activeAt } = {}) => {
  const artifact = {
    id: 'forecast-challenger-v2-reduced-pressure-stored',
    version: CHALLENGER_MODEL_VERSION,
    kind: 'reduced-pressure',
    variantName: 'reduced-pressure',
    status: 'shadow',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    policyVersion: CHALLENGER_POLICY_VERSION,
    variantPolicyVersion: getChallengerPolicyVersion('reduced-pressure'),
    trainedAt,
    trainingCutoffAt: trainedAt - contractDuration,
    shadowStartsAt: trainedAt,
    featureVersion: LEARNING_FEATURE_VERSION,
    pipeline: {
      featureVersion: LEARNING_FEATURE_VERSION,
      baselineModelVersion: 'kalshi-brti-average-v3',
      referenceSource: 'cf-brti',
      featureInputSource: 'cf-brti-history',
    },
    applicability: { minimumHorizonMinutes: 1, maximumHorizonMinutes: 12 },
    requirements: { ...CHALLENGER_REQUIREMENTS },
    calibration: {
      version: CHALLENGER_CALIBRATION_VERSION,
      primaryCutoffAt: trainedAt - 30 * contractDuration,
      startedAt: trainedAt - 29 * contractDuration,
      cutoffAt: trainedAt - contractDuration,
      independentWindows: 20,
      checkpoints: [12, 9, 6, 3, 1].map((checkpointMinutes) => ({
        checkpointMinutes,
        status: 'identity',
        samples: 0,
        offset: 0,
      })),
    },
    evaluation: { eligibleForShadow: true, reasons: [] },
    ...(enrolled ? { enrollmentPolicy: 'collector-enrollment-v1' } : {}),
  };
  if (activeAt !== undefined)
    artifact.activation = {
      modelId: artifact.id,
      activatedAt: activeAt,
      shadowEvaluation: {
        modelId: artifact.id,
        evaluatedAt: activeAt,
        phase: 'confirmation',
        eligibleForPromotion: true,
        approvedCheckpoints: [9],
      },
    };
  return artifact;
};

export const createTrainingSeed = () =>
  createLearningEvents({
    count: 2,
    startAt: trainedAt - 4 * contractDuration,
  });

export const createChallengerEvents = ({
  model,
  count = 60,
  startAt = trainedAt + contractDuration,
  improve = true,
  active = false,
  missingPredictionIndex = -1,
  missingOutcomeIndex = -1,
} = {}) => {
  const events = createLearningEvents({ count, startAt });
  for (let index = 0; index < count; index += 1) {
    const decision = events[index * 2];
    const baseline = decision.aboveProbability;
    const yes = index % 2 === 0;
    const candidateProbability = improve ? (yes ? 0.85 : 0.15) : yes ? 0.2 : 0.8;
    if (active) {
      decision.aboveProbability = candidateProbability;
      decision.belowProbability = 1 - candidateProbability;
      decision.learning = {
        applied: true,
        modelId: model.id,
        aboveProbability: candidateProbability,
        baselineAboveProbability: baseline,
      };
    }
    const reference = {
      available: true,
      referenceSource: 'cf-brti',
      referenceAt: decision.capturedAt,
      referencePrice: decision.spot,
      minuteVolatility: 0.001,
    };
    decision.researchExperiment = {
      version: RESEARCH_EXPERIMENT_V4,
      capturedAt: decision.capturedAt,
      target: decision.target,
      expiresAt: decision.expiresAt,
      marketTicker: decision.kalshiMarket.ticker,
      production: { aboveProbability: decision.aboveProbability },
      variants: {
        combined: { ...reference, aboveProbability: baseline, belowProbability: 1 - baseline },
        ...(index === missingPredictionIndex
          ? {}
          : {
              [model.variantName]: {
                ...reference,
                modelId: model.id,
                policyVersion: model.variantPolicyVersion,
                featureCutoffAt: decision.capturedAt,
                rawAboveProbability: candidateProbability,
                aboveProbability: candidateProbability,
                belowProbability: 1 - candidateProbability,
              },
            }),
      },
    };
  }
  return events.filter((_row, index) => index !== missingOutcomeIndex * 2 + 1);
};

export const endOfEvents = (events) => Math.max(...events.map((row) => row.recordedAt));

export const createConfirmation = (model, startedAt, overrides = {}) => ({
  modelId: model.id,
  startedAt,
  developmentCutoffAt: startedAt,
  productionModelId: null,
  productionActivatedAt: null,
  approvedCheckpoints: [9],
  attemptNumber: 1,
  status: 'collecting',
  cohortForecastIds: [],
  activatedAt: null,
  ...overrides,
});

export const createForwardTrainingHistory = () => {
  const events = createChallengerEvents({ model: createChallenger(), count: 80 });
  const labels = [];
  events
    .filter((row) => row.event === 'decision')
    .forEach((decision, index) => {
      decision.quoteTime = decision.capturedAt;
      decision.receivedAt = decision.capturedAt;
      decision.learningFeatures.values[13] = index % 2 ? -0.5 : 0.5;
      decision.learningFeatures.values[20] = 1;
      decision.researchExperiment.variants['settlement-only'] = {
        available: true,
        referenceSource: 'cf-brti',
        referencePrice: decision.spot,
        minuteVolatility: 0.001,
        expectedSettlementAverage: decision.spot,
        settlementStandardDeviation: 75,
      };
      const dueAt = decision.capturedAt + 60_000;
      const futurePrice = decision.spot * Math.exp(index % 2 ? -0.0005 : 0.0005);
      labels.push({
        version: 'brti-forward-label-v1',
        labelId: `${decision.eventId}:forward:60`,
        snapshotId: decision.eventId,
        forecastId: decision.forecastId,
        status: 'observed',
        horizonSeconds: 60,
        capturedAt: decision.capturedAt,
        recordedAt: dueAt,
        dueAt,
        reference: {
          source: 'cf-brti',
          time: decision.quoteTime,
          receivedAt: decision.receivedAt,
          price: decision.spot,
        },
        reading: { time: dueAt, receivedAt: dueAt, price: futurePrice },
        logReturn: Math.log(futurePrice / decision.spot),
      });
    });
  return { events, labels };
};

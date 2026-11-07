import { getResearchForecast } from '@/features/ForecastResearch/utils/researchForecast.utils';
import { getLearningFeatureSchema } from '@/features/ForecastResearch/features/ModelLearning/utils/features.utils';
import {
  CALIBRATION_VERSION,
  OUTCOME_MODEL_VERSION,
} from '@/features/ForecastResearch/features/ModelLearning/utils/model.utils';
import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';
import { createMarketFeed, currentMarket, eventStart } from '../../helpers/liveEstimateFixtures';

// A synthetic exported classifier is the model-service input boundary. Its
// intercept gives a known 70% Yes estimate; no training or research job runs.
export const createLearnedModel = (now = eventStart) => {
  const snapshot = getResearchForecast({
    ...createMarketFeed(now),
    now,
    kalshiMarket: currentMarket,
  }).learningFeatures;
  const schema = getLearningFeatureSchema(snapshot.schemaVersion);
  const dayMilliseconds = 24 * 60 * 60_000;
  const trainedAt = eventStart - 7 * dayMilliseconds;
  const id = `${OUTCOME_MODEL_VERSION}-live-estimate-fixture`;
  return {
    id,
    version: OUTCOME_MODEL_VERSION,
    featureVersion: snapshot.schemaVersion,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    status: 'shadow',
    trainedAt,
    trainingCutoffAt: trainedAt - 3 * dayMilliseconds,
    calibrationCutoffAt: trainedAt - 2 * dayMilliseconds,
    evaluationCutoffAt: trainedAt - dayMilliseconds,
    shadowStartsAt: trainedAt,
    applicability: {
      baselineModelVersion: snapshot.baselineModelVersion,
      referenceSources: [snapshot.referenceSource],
      featureInputSources: [snapshot.featureInputSource],
      minimumHorizonMinutes: 1,
      maximumHorizonMinutes: 15,
      minimumTargetDistance: -8,
      maximumTargetDistance: 8,
      availabilityPatterns: [
        schema.availabilityIndexes.map((index) => snapshot.values[index]).join(''),
      ],
    },
    model: {
      indexes: schema.names.map((_, index) => index),
      means: schema.names.map(() => 0),
      scales: schema.names.map(() => 1),
      coefficients: [Math.log(0.7 / 0.3), ...schema.names.map(() => 0)],
    },
    calibration: {
      version: CALIBRATION_VERSION,
      model: { indexes: [0], means: [0], scales: [1], coefficients: [0, 1] },
    },
    activation: {
      modelId: id,
      activatedAt: eventStart - dayMilliseconds / 2,
      shadowEvaluation: {
        modelId: id,
        evaluatedAt: eventStart - dayMilliseconds,
        eligibleForPromotion: true,
      },
    },
  };
};

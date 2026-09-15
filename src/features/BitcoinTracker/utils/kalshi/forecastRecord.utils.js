import { KALSHI_OUTCOME_DEFINITION } from './contract.utils';
import { KALSHI_MODEL_VERSION } from './forecast.utils';
import {
  getFixedForecastAnalysis,
  KALSHI_POLICY_VERSION,
  KALSHI_CHECKPOINT_POLICY_VERSION,
} from '../fixedPrediction.utils';

/** Manual and scheduled starts capture the same contract before observation begins. */
export function createKalshiForecastRecord({
  id,
  contract,
  createdAt,
  price,
  modelVersion = KALSHI_MODEL_VERSION,
  checkpointMinutes,
  captureOrigin,
}) {
  const usesCheckpoint = checkpointMinutes !== undefined;
  return {
    id,
    startsAt: contract.startsAt,
    timingMode: 'end',
    createdAt,
    expiresAt: contract.expiresAt,
    price,
    target: contract.target,
    ...(usesCheckpoint ? { checkpointMinutes } : {}),
    ...(captureOrigin === undefined ? {} : { captureOrigin }),
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion,
    status: 'analyzing',
    calculationMode: null,
    analysis: getFixedForecastAnalysis({
      startedAt: createdAt,
      expiresAt: contract.expiresAt,
      policyVersion: usesCheckpoint ? KALSHI_CHECKPOINT_POLICY_VERSION : KALSHI_POLICY_VERSION,
      checkpointMinutes,
    }),
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshiMarket: contract,
    kalshi: null,
  };
}

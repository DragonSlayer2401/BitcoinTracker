import { KALSHI_OUTCOME_DEFINITION } from './contract.utils';
import { KALSHI_MODEL_VERSION } from './forecast.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../fixedPrediction.utils';

/** Manual and scheduled starts capture the same contract before observation begins. */
export function createKalshiForecastRecord({ id, contract, createdAt, price }) {
  return {
    id,
    startsAt: contract.startsAt,
    timingMode: 'end',
    createdAt,
    expiresAt: contract.expiresAt,
    price,
    target: contract.target,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion: KALSHI_MODEL_VERSION,
    status: 'analyzing',
    calculationMode: null,
    analysis: getFixedForecastAnalysis({
      startedAt: createdAt,
      expiresAt: contract.expiresAt,
      policyVersion: KALSHI_POLICY_VERSION,
    }),
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshiMarket: contract,
    kalshi: null,
  };
}

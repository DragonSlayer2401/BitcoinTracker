import { createKalshiForecastRecord } from '../../../CheckpointForecasts/utils/kalshi/forecastRecord.utils';
import { KALSHI_CHECKPOINT_POLICY_VERSION } from '../../../CheckpointForecasts/utils/fixedPrediction.utils';
import { KALSHI_MODEL_PARAMETERS } from '../../../LiveEstimates/utils/kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';

export const journalNow = Date.UTC(2026, 10, 6, 12);

// These are saved browser records, the input boundary when a user opens history.
// Fixed probabilities are deliberate so UI metrics have independently known answers.
export const createSavedForecast = ({
  id,
  status = 'resolved',
  startsAt = journalNow - 900_000,
  target = 50_000,
  checkpointMinutes = 9,
  aboveProbability = 0.8,
  result = 'yes',
  captureOrigin = 'manual',
} = {}) => {
  const expiresAt = startsAt + 900_000;
  const contract = {
    ticker: `KXBTC15M-${expiresAt}-15`,
    eventTicker: `KXBTC15M-${expiresAt}`,
    seriesTicker: 'KXBTC15M',
    target,
    startsAt,
    expiresAt,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const record = createKalshiForecastRecord({
    id: id ?? `${status}-${startsAt}-${checkpointMinutes}`,
    contract,
    createdAt: startsAt,
    price: target + 50,
    checkpointMinutes,
    captureOrigin,
  });
  if (status === 'analyzing') return record;
  if (status === 'withheld')
    return { ...record, status, withholdingReason: 'market-data-unavailable' };
  const createdAt = expiresAt - checkpointMinutes * 60_000;
  const direction =
    aboveProbability === 0.5 ? 'neutral' : aboveProbability > 0.5 ? 'above' : 'below';
  const issued = {
    ...record,
    status,
    createdAt,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction,
    calculationMode: 'baseline-fallback',
    kalshi: {
      marketTicker: contract.ticker,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      referenceSource: 'cf-brti',
      modelKind: 'experimental',
      approximate: true,
      observedSampleCount: 0,
      missingElapsedSampleCount: 0,
      futureSampleCount: 60,
      referencePrice: target + 50,
      expectedSettlementAverage: target + 50,
      settlementStandardDeviation: 75,
      settlementLowerBound: target - 100,
      settlementUpperBound: target + 150,
      referenceAt: createdAt,
      basisLogDeviation: 0,
      requiredFutureAverage: target,
      warning: '',
      basisAssumption: null,
      parameters: { ...KALSHI_MODEL_PARAMETERS },
    },
  };
  if (status !== 'resolved') return issued;
  const outcome = result === 'yes' ? 'above' : 'below';
  const observedPrice = target + (result === 'yes' ? 100 : -100);
  return {
    ...issued,
    observedPrice,
    observedAt: expiresAt,
    outcome,
    correct: direction === 'neutral' ? null : direction === outcome,
    kalshiOutcome: {
      status: 'observed',
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      marketTicker: contract.ticker,
      target,
      expiresAt,
      observedPrice,
      observedAt: expiresAt,
      outcome,
      result,
      confirmedThrough: expiresAt,
      settledAt: expiresAt,
      comparison: 'greater_or_equal',
      roundDigits: 2,
    },
  };
};

export const createSavedSchedule = () => ({
  id: 'scheduled-next-event',
  createdAt: journalNow,
  startsAt: journalNow + 900_000,
  expiresAt: journalNow + 1_800_000,
  target: null,
  status: 'scheduled',
  marketTicker: 'KXBTC15M-26NOV061230-30',
  eventTicker: 'KXBTC15M-26NOV061230',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION,
  checkpointMinutes: [9, 6],
  captureOrigin: 'manual',
});

export const createSettledMarket = (forecast, { result = 'yes', ...overrides } = {}) => ({
  ...forecast.kalshiMarket,
  status: 'settled',
  result,
  settlementPrice: forecast.target + (result === 'yes' ? 100 : -100),
  receivedAt: forecast.expiresAt,
  ...overrides,
});

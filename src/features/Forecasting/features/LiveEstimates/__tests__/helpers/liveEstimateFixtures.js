import { createKalshiForecastRecord } from '../../../CheckpointForecasts/utils/kalshi/forecastRecord.utils';
import { KALSHI_MODEL_PARAMETERS } from '../../utils/kalshi/forecast.utils';
import {
  getKalshiContract,
  KALSHI_OUTCOME_DEFINITION,
} from '@/features/MarketData/utils/kalshi/contract.utils';

export const eventStart = Date.UTC(2026, 10, 6, 12);
export const eventEnd = eventStart + 900_000;
export const currentMarket = {
  ticker: 'KXBTC15M-26NOV061215-15',
  eventTicker: 'KXBTC15M-26NOV061215',
  seriesTicker: 'KXBTC15M',
  startsAt: eventStart,
  expiresAt: eventEnd,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
};
export const nextMarket = {
  ...currentMarket,
  ticker: 'KXBTC15M-26NOV061230-30',
  eventTicker: 'KXBTC15M-26NOV061230',
  startsAt: eventEnd,
  expiresAt: eventEnd + 900_000,
  target: null,
  status: 'initialized',
};

export const createMarketFeed = (now, price = 50_000) => {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: Math.floor(now / 1000) * 1000 - (1200 - index) * 1000,
    price: price * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
    receivedAt: now,
  }));
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price * Math.exp(Math.sin((index - 120) / 5) * 0.0005);
    const close = price * Math.exp(Math.sin((index - 119) / 5) * 0.0005);
    return {
      time: Math.floor(now / 60_000) * 60_000 - (120 - index) * 60_000,
      open,
      close,
      high: Math.max(open, close) * 1.0002,
      low: Math.min(open, close) * 0.9998,
      volume: 5 + (index % 7),
    };
  });
  return {
    candles,
    ticker: { price, bid: price - 1, ask: price + 1, volume: 100, time: now, receivedAt: now },
    benchmark: { available: true, receivedAt: now, current: samples.at(-1), samples },
    stream: {},
    derivatives: {},
    hasRequestError: false,
    hasContractError: false,
    isLoading: false,
  };
};

// Restored browser calls are an input boundary. Their known probabilities let
// the UI compare a live estimate with a saved call without mocking calculations.
export const createSavedForecast = ({
  id = 'restored-call',
  status = 'pending',
  startsAt = eventStart,
  target = 50_000,
  checkpointMinutes = 9,
  aboveProbability = 0.8,
} = {}) => {
  const contract = getKalshiContract({
    ...currentMarket,
    target,
    startsAt,
    expiresAt: startsAt + 900_000,
    ...(startsAt === eventStart
      ? {}
      : {
          ticker: `KXBTC15M-${startsAt + 900_000}-15`,
          eventTicker: `KXBTC15M-${startsAt + 900_000}`,
        }),
  });
  const record = createKalshiForecastRecord({
    id,
    contract,
    createdAt: startsAt,
    price: target + 50,
    checkpointMinutes,
    captureOrigin: 'manual',
  });
  if (status === 'analyzing') return record;
  if (status === 'withheld')
    return { ...record, status, withholdingReason: 'market-data-unavailable' };
  const createdAt = contract.expiresAt - checkpointMinutes * 60_000;
  return {
    ...record,
    status,
    createdAt,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction: aboveProbability === 0.5 ? 'neutral' : aboveProbability > 0.5 ? 'above' : 'below',
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
};

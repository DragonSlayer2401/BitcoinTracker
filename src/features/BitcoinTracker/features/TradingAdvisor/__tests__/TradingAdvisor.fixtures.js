import { KALSHI_OUTCOME_DEFINITION } from '../../../utils/kalshi/contract.utils';

export const START = Date.UTC(2026, 9, 3, 12);
export const contract = {
  ticker: 'KXBTC15M-26OCT031215-15',
  eventTicker: 'KXBTC15M-26OCT031215',
  seriesTicker: 'KXBTC15M',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  rulesVerified: true,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  target: 75000,
  startsAt: START,
  expiresAt: START + 900000,
};
export const bookAt = (now) => ({
  ticker: contract.ticker,
  requestedAt: now,
  receivedAt: now,
  yesAsks: [{ price: 0.5, quantity: 100 }],
  noAsks: [{ price: 0.55, quantity: 100 }],
  fee: {
    available: true,
    type: 'quadratic',
    multiplier: 1,
    checkedAt: now,
    validUntil: now + 30000,
  },
});
export const forecastAt = (now, aboveProbability = 0.85) => ({
  available: true,
  aboveProbability,
  capturedAt: now,
  modelVersion: 'test-v1',
  modelId: null,
  researchInputSnapshot: { timing: { replayable: true }, capturedAt: now, inputs: ['fixture'] },
});
export const outcomeAt = (now, result = 'yes') => ({
  ...contract,
  status: 'settled',
  result,
  settlementPrice: result === 'yes' ? 76000 : 74000,
  settledAt: now,
  receivedAt: now,
});

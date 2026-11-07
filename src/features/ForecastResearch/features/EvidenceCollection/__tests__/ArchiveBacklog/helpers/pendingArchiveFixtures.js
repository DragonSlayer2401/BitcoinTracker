import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';
import { appendEvidenceRows } from '../../../utils/evidenceStorage.utils';
import { createSavedForecast, eventStart } from '../../helpers/evidenceFixtures';

const savedContract = createSavedForecast({ startsAt: eventStart - 900_000 }).kalshiMarket;

export const createPendingEvidence = (index, { sampleCount = 0 } = {}) => {
  const recordedAt = eventStart - 60_000 + index;
  const row = {
    schemaVersion: 1,
    eventId: `saved-evidence-${index}`,
    forecastId: `saved-forecast-${index}`,
    event: 'observation',
    recordedAt,
    inputObservedAt: recordedAt,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshiMarket: savedContract,
    cohort: 'manual',
    target: 50_000,
    spot: 50_100,
    expiresAt: savedContract.expiresAt,
    aboveProbability: 0.7,
    belowProbability: 0.3,
  };
  if (sampleCount)
    row.researchInputSnapshot = {
      version: 'kalshi-input-replay-v1',
      capturedAt: recordedAt,
      input: {
        now: recordedAt,
        target: 50_000,
        expiresAt: savedContract.expiresAt,
        benchmark: {
          available: true,
          receivedAt: recordedAt,
          samples: Array.from({ length: sampleCount }, (_, sampleIndex) => ({
            time: recordedAt - (sampleCount - sampleIndex) * 1000,
            receivedAt: recordedAt,
            price: 50_000 + (sampleIndex % 100),
          })),
        },
      },
      models: {},
    };
  return row;
};

// Saved IndexedDB contents are the browser boundary. The mounted workflow reads,
// batches, uploads, acknowledges, and exports these records with production code.
export const savePendingEvidence = async (rows) => appendEvidenceRows(rows);

export const serializedBytes = (value) => new Blob([JSON.stringify(value)]).size;

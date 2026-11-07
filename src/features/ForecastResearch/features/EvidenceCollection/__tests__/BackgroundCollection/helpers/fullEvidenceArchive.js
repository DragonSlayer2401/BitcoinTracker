import { currentMarket, eventEnd, eventStart } from '../../helpers/evidenceFixtures';
import { getKalshiContract } from '@/features/MarketData/utils/kalshi/contract.utils';

// A previously accumulated device archive is an IndexedDB input boundary. Keep
// the records compact while retaining valid contract identity and provenance.
export const seedFullEvidenceArchive = async () => {
  const kalshiMarket = getKalshiContract({
    ...currentMarket,
    ticker: 'KXBTC15M-26NOV051215-15',
    eventTicker: 'KXBTC15M-26NOV051215',
    startsAt: eventStart - 86_400_000,
    expiresAt: eventEnd - 86_400_000,
  });
  const rows = Array.from({ length: 25_000 }, (_, index) => ({
    schemaVersion: 1,
    eventId: `archived-evidence-${index}`,
    forecastId: `archived-call-${index}`,
    event: 'restored',
    recordedAt: kalshiMarket.expiresAt + index,
    cohort: 'manual',
    sessionOrigin: 'restored',
    inputStatus: 'restored-without-inputs',
    inputObservedAt: null,
    target: kalshiMarket.target,
    expiresAt: kalshiMarket.expiresAt,
    outcomeDefinition: kalshiMarket.outcomeDefinition,
    kalshiMarket,
  }));
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('bitcoin-tracker-evidence', 2);
    request.onupgradeneeded = () => {
      const events = request.result.createObjectStore('events', { keyPath: 'eventId' });
      events.createIndex('recordedAt', 'recordedAt');
      request.result.createObjectStore('forecast-outbox', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('events', 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      const events = transaction.objectStore('events');
      for (const row of rows) events.add(row);
    });
  } finally {
    database.close();
  }
  return rows;
};

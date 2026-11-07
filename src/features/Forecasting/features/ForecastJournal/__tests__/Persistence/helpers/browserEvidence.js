import { openEvidenceDatabase } from '@/features/ForecastResearch/features/EvidenceCollection/utils/evidenceStorage.utils';

export const seedBrowserEvidence = async (rows) => {
  const database = await openEvidenceDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['events', 'forecast-outbox'], 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      rows.forEach((row) => {
        transaction.objectStore('events').put(row);
        transaction.objectStore('forecast-outbox').put({ key: row.eventId, forecast: row });
      });
    });
  } finally {
    database.close();
  }
};

export const readBrowserEvidence = async (storeName) => {
  const database = await openEvidenceDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
};

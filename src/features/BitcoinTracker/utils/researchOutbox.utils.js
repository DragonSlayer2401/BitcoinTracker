import { openEvidenceDatabase } from './evidenceStorage.utils';

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error('Research outbox could not be saved.'));
    transaction.onabort = () => reject(new Error('Research outbox was interrupted.'));
  });
}

export async function queueForecastSnapshots(forecasts) {
  if (!forecasts.length) return;
  const database = await openEvidenceDatabase();
  try {
    const transaction = database.transaction('forecast-outbox', 'readwrite');
    const done = waitForTransaction(transaction);
    const store = transaction.objectStore('forecast-outbox');
    const queuedKeys = new Set();
    for (const forecast of forecasts) {
      const key = `${forecast.id}:${forecast.status}`;
      if (queuedKeys.has(key)) continue;
      queuedKeys.add(key);
      const request = store.getKey(key);
      request.onsuccess = () => {
        if (request.result === undefined) store.add({ key, forecast });
      };
    }
    await done;
  } finally {
    database.close();
  }
}

export async function readResearchOutbox(limit = 50) {
  const database = await openEvidenceDatabase();
  try {
    const transaction = database.transaction(['events', 'forecast-outbox'], 'readonly');
    const done = waitForTransaction(transaction);
    let evidence = [];
    let snapshots = [];
    const events = transaction.objectStore('events').index('recordedAt').getAll(null, limit);
    const forecasts = transaction.objectStore('forecast-outbox').getAll(null, limit);
    events.onsuccess = () => {
      evidence = events.result;
    };
    forecasts.onsuccess = () => {
      snapshots = forecasts.result;
    };
    await done;
    // Full decision inputs can exceed the size of ordinary evidence. Keep uploads under
    // the server's 4 MiB limit; excluded rows remain in the outbox for the next batch.
    let bytes = 100;
    const takeWithinBudget = (rows) => {
      const selected = [];
      for (const row of rows) {
        const size = new Blob([JSON.stringify(row)]).size + 1;
        if (bytes + size > 3 * 1024 * 1024) break;
        bytes += size;
        selected.push(row);
      }
      return selected;
    };
    const batch = {
      evidence: takeWithinBudget(evidence),
      forecasts: takeWithinBudget(snapshots.map((row) => row.forecast)),
    };
    if ((evidence.length || snapshots.length) && !batch.evidence.length && !batch.forecasts.length)
      throw new Error(
        'A research record exceeds the upload size limit. The original record is retained.',
      );
    return batch;
  } finally {
    database.close();
  }
}

// Only call after the server has committed the exact batch. Failed uploads never remove data.
export async function acknowledgeResearchBatch({ evidence, forecasts }) {
  const database = await openEvidenceDatabase();
  try {
    const transaction = database.transaction(['events', 'forecast-outbox'], 'readwrite');
    const done = waitForTransaction(transaction);
    for (const row of evidence) transaction.objectStore('events').delete(row.eventId);
    for (const forecast of forecasts)
      transaction.objectStore('forecast-outbox').delete(`${forecast.id}:${forecast.status}`);
    await done;
  } finally {
    database.close();
  }
}

import { openEvidenceDatabase } from '../evidenceStorage.utils';
import { getValidatedJournalState } from '../journal.utils';
import { KALSHI_OUTCOME_DEFINITION } from './contract.utils';

const JOURNAL_KEY = 'bitcoin-tracker:journal:v1';
const RECORDER_KEY_PREFIX = 'bitcoin-tracker:background-research';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function getRetainedJournal(serialized) {
  if (serialized === null) {
    return { journal: { forecasts: [], scheduledForecast: null }, needsWrite: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Saved journal could not be read. Cleanup paused without replacing it.');
  }
  if (
    !isRecord(parsed) ||
    ![1, 2, 3, 4, 5, 6, 7].includes(parsed.version) ||
    Object.keys(parsed).length !== (parsed.version === 1 ? 2 : 3) ||
    !Array.isArray(parsed.forecasts) ||
    !parsed.forecasts.every(isRecord) ||
    (parsed.version !== 1 &&
      parsed.scheduledForecast !== null &&
      !isRecord(parsed.scheduledForecast))
  ) {
    throw new Error('Saved journal has an unknown format. Cleanup paused without replacing it.');
  }
  const forecasts = parsed.forecasts.filter(
    (forecast) => forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION,
  );
  const scheduledForecast =
    parsed.scheduledForecast?.outcomeDefinition === KALSHI_OUTCOME_DEFINITION
      ? parsed.scheduledForecast
      : null;
  if (parsed.version < 7 && (forecasts.length || scheduledForecast)) {
    throw new Error('Kalshi records have an invalid journal version. Cleanup preserved them.');
  }
  const journal = getValidatedJournalState({ forecasts, scheduledForecast });
  if (!journal) {
    throw new Error('Saved Kalshi records could not be validated. Cleanup preserved them.');
  }
  return {
    journal,
    needsWrite:
      forecasts.length !== parsed.forecasts.length ||
      (parsed.scheduledForecast != null && scheduledForecast === null),
  };
}

async function removeLegacyOutboxRows(openDatabase) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['events', 'forecast-outbox'], 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onerror = () =>
        reject(new Error('Local research cleanup failed. Uploads remain paused.'));
      transaction.onabort = () =>
        reject(new Error('Local research cleanup was interrupted. Uploads remain paused.'));
      for (const storeName of ['events', 'forecast-outbox']) {
        const request = transaction.objectStore(storeName).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const row = storeName === 'events' ? cursor.value : cursor.value?.forecast;
          if (row?.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION) cursor.delete();
          cursor.continue();
        };
      }
    });
  } finally {
    database.close();
  }
}

/** User-authorized removal of the old Coinbase workflow; safe to retry after partial failure. */
export async function cleanupLegacyBrowserResearch({
  storage = globalThis.localStorage,
  openDatabase = openEvidenceDatabase,
} = {}) {
  const original = storage.getItem(JOURNAL_KEY);
  // Validate every retained record before deleting anything. An unreadable journal is not empty.
  const { journal, needsWrite } = getRetainedJournal(original);
  await removeLegacyOutboxRows(openDatabase);
  // Another tab may have written a new Kalshi call while IndexedDB cleanup was in flight.
  if (storage.getItem(JOURNAL_KEY) !== original) {
    throw new Error(
      'The saved journal changed during cleanup. Reload to retry without losing records.',
    );
  }
  if (needsWrite) storage.setItem(JOURNAL_KEY, JSON.stringify({ version: 7, ...journal }));
  const recorderKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of recorderKeys) {
    if (
      typeof key === 'string' &&
      (key === RECORDER_KEY_PREFIX || key.startsWith(`${RECORDER_KEY_PREFIX}:`)) &&
      !key.includes(':kalshi:')
    )
      storage.removeItem(key);
  }
  return journal;
}

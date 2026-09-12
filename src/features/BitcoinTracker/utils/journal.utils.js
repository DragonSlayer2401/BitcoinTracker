import {
  JOURNAL_VERSION,
  getValidatedJournalState,
  getValidatedSavedJournal,
} from './journal/journalValidation.utils';

export { getValidatedForecast } from './journal/forecastValidation.utils';
export { getValidatedScheduledForecast } from './journal/scheduleValidation.utils';
export { getValidatedJournal, getValidatedJournalState } from './journal/journalValidation.utils';

const JOURNAL_STORAGE_KEY = 'bitcoin-tracker:journal:v1';

export function loadJournal(storage) {
  let savedJournal;
  try {
    const journalStorage = storage === undefined ? window.localStorage : storage;
    savedJournal = journalStorage.getItem(JOURNAL_STORAGE_KEY);
  } catch {
    return {
      forecasts: [],
      scheduledForecast: null,
      warning: 'Forecast history is unavailable on this device.',
    };
  }

  if (savedJournal === null) return { forecasts: [], scheduledForecast: null, warning: null };

  try {
    const parsedJournal = JSON.parse(savedJournal);
    const journal = getValidatedSavedJournal(parsedJournal);
    if (journal === null) throw new Error('Invalid forecast history.');
    return { ...journal, warning: null };
  } catch {
    return {
      forecasts: [],
      scheduledForecast: null,
      warning: 'Saved forecast history was invalid and has been ignored.',
    };
  }
}

export function saveJournal(forecasts, storage, scheduledForecast = null) {
  const journal = getValidatedJournalState({ forecasts, scheduledForecast });
  if (journal === null) return 'Forecast history could not be saved because it was invalid.';

  try {
    const journalStorage = storage === undefined ? window.localStorage : storage;
    journalStorage.setItem(
      JOURNAL_STORAGE_KEY,
      JSON.stringify({ version: JOURNAL_VERSION, ...journal }),
    );
    return null;
  } catch {
    return 'Forecast history could not be saved on this device.';
  }
}

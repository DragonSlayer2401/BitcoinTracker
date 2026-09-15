import { useEffect, useState } from 'react';
import { useStore } from 'react-redux';
import { journalSynchronized, storageWarningChanged } from '../state/slices/trackerSlice';
import { JOURNAL_STORAGE_KEY, loadJournal, saveJournal } from '../utils/journal.utils';
import { cleanupLegacyBrowserResearch } from '../utils/kalshi/browserCleanup.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

export const JOURNAL_LOCK_NAME = 'bitcoin-tracker:forecast-journal:writer';

/** One tab records and persists; other tabs follow its immutable saved calls. */
export default function useForecastJournal() {
  const store = useStore();
  const [status, setStatus] = useState({ isRestored: false, isOwner: false, isReady: false });
  useEffect(() => {
    const initial = store.getState().tracker;
    if (
      initial.forecasts.some(
        (forecast) => forecast.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION,
      ) ||
      (initial.scheduledForecast &&
        initial.scheduledForecast.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION)
    ) {
      store.dispatch(
        storageWarningChanged(
          'Old forecast state is still open in this tab. Recording and uploads are paused. Reload to retry.',
        ),
      );
      return;
    }
    let disposed = false;
    let ownsJournal = false;
    let unsubscribe = null;
    let release = null;
    const controller = new AbortController();
    const synchronize = () => {
      if (ownsJournal || disposed) return;
      const { warning, ...journal } = loadJournal();
      if (warning) store.dispatch(storageWarningChanged(warning));
      else {
        store.dispatch(journalSynchronized(journal));
        setStatus({ isRestored: true, isOwner: false, isReady: false });
      }
    };
    const onStorage = (event) => {
      if (event.key === JOURNAL_STORAGE_KEY) synchronize();
    };
    synchronize();
    window.addEventListener('storage', onStorage);
    if (!navigator.locks?.request) {
      store.dispatch(
        storageWarningChanged(
          'This browser cannot coordinate saved forecasts across tabs. Use a browser with Web Locks to enable recording.',
        ),
      );
    } else {
      // Queue for ownership so a waiting tab takes over after the recording tab closes.
      navigator.locks
        .request(JOURNAL_LOCK_NAME, { signal: controller.signal }, async () => {
          if (disposed) return;
          ownsJournal = true;
          const journal = await cleanupLegacyBrowserResearch();
          if (disposed) return;
          store.dispatch(journalSynchronized(journal));
          store.dispatch(storageWarningChanged(null));
          let previous = store.getState().tracker;
          // Persist synchronously during dispatch, before another effect can upload a decision.
          unsubscribe = store.subscribe(() => {
            const current = store.getState().tracker;
            if (
              current.forecasts === previous.forecasts &&
              current.scheduledForecast === previous.scheduledForecast
            )
              return;
            previous = current;
            const warning = saveJournal(current.forecasts, undefined, current.scheduledForecast);
            if (warning) {
              setStatus({ isRestored: true, isOwner: true, isReady: false });
              store.dispatch(
                storageWarningChanged(`${warning} Recording paused; reload to retry.`),
              );
            }
          });
          setStatus({ isRestored: true, isOwner: true, isReady: true });
          await new Promise((resolve) => {
            release = resolve;
          });
        })
        .catch((error) => {
          if (disposed || error.name === 'AbortError') return;
          ownsJournal = false;
          setStatus({ isRestored: true, isOwner: false, isReady: false });
          store.dispatch(
            storageWarningChanged(
              `${error.message || 'Forecast storage is unavailable.'} Recording paused; reload to retry.`,
            ),
          );
        });
    }
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe?.();
      release?.();
      window.removeEventListener('storage', onStorage);
    };
  }, [store]);
  return status;
}

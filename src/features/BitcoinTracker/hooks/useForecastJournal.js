import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { historyRestored, storageWarningChanged } from '../state/slices/trackerSlice';
import { selectForecasts, selectScheduledForecast } from '../state/selectors/trackerSelectors';
import { saveJournal } from '../utils/journal.utils';
import { cleanupLegacyBrowserResearch } from '../utils/kalshi/browserCleanup.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

export default function useForecastJournal() {
  const dispatch = useDispatch();
  const forecasts = useSelector(selectForecasts);
  const scheduledForecast = useSelector(selectScheduledForecast);
  const [isRestored, setIsRestored] = useState(false);
  const cleanup = useRef(null);
  const hasLegacyState =
    forecasts.some((forecast) => forecast.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION) ||
    (scheduledForecast !== null &&
      scheduledForecast.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION);

  useEffect(() => {
    let disposed = false;
    // Reuse the in-flight operation during StrictMode's effect replay.
    if (!cleanup.current) cleanup.current = cleanupLegacyBrowserResearch();
    cleanup.current
      .then((journal) => {
        if (disposed) return;
        if (hasLegacyState) throw new Error('Old forecast state is still open in this tab.');
        dispatch(historyRestored(journal));
        dispatch(storageWarningChanged(null));
        setIsRestored(true);
      })
      .catch((error) => {
        if (!disposed)
          dispatch(
            storageWarningChanged(
              `${error?.message || 'Local research cleanup failed.'} Forecast recording and uploads are paused. Reload to retry.`,
            ),
          );
      });
    return () => {
      disposed = true;
    };
  }, [dispatch, hasLegacyState]);

  useEffect(() => {
    if (!isRestored) return;
    const warning = saveJournal(forecasts, undefined, scheduledForecast);
    if (warning) dispatch(storageWarningChanged(warning));
  }, [dispatch, forecasts, scheduledForecast, isRestored]);

  return isRestored;
}

import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { historyRestored, storageWarningChanged } from '../state/slices/trackerSlice';
import { selectForecasts, selectScheduledForecast } from '../state/selectors/trackerSelectors';
import { loadJournal, saveJournal } from '../utils/journal.utils';

export default function useForecastJournal() {
  const dispatch = useDispatch();
  const forecasts = useSelector(selectForecasts);
  const scheduledForecast = useSelector(selectScheduledForecast);
  const [isRestored, setIsRestored] = useState(false);

  useEffect(() => {
    const { forecasts: restored, scheduledForecast: restoredSchedule, warning } = loadJournal();
    dispatch(historyRestored({ forecasts: restored, scheduledForecast: restoredSchedule }));
    dispatch(storageWarningChanged(warning));
    setIsRestored(true);
  }, [dispatch]);

  useEffect(() => {
    if (!isRestored) return;
    const warning = saveJournal(forecasts, undefined, scheduledForecast);
    if (warning) dispatch(storageWarningChanged(warning));
  }, [dispatch, forecasts, scheduledForecast, isRestored]);

  return isRestored;
}

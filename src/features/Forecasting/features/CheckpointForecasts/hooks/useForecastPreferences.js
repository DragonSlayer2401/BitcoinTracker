import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_FORECAST_PREFERENCES,
  FORECAST_PREFERENCES_STORAGE_KEY,
  getValidatedForecastPreferences,
  readForecastPreferences,
  writeForecastPreferences,
} from '../utils/forecastAutomation.utils';

/** Local control preferences synchronize across tabs without becoming forecast state. */
export default function useForecastPreferences() {
  const [preferences, setPreferences] = useState(() => ({
    autoEnabled: DEFAULT_FORECAST_PREFERENCES.autoEnabled,
    checkpointMinutes: [...DEFAULT_FORECAST_PREFERENCES.checkpointMinutes],
  }));
  const [isRestored, setIsRestored] = useState(false);
  const [warning, setWarning] = useState(null);

  useEffect(() => {
    const restore = () => {
      const saved = readForecastPreferences();
      setPreferences(saved.preferences);
      setWarning(saved.warning);
      setIsRestored(true);
    };
    const handleStorage = (event) => {
      if (event.key === null || event.key === FORECAST_PREFERENCES_STORAGE_KEY) restore();
    };
    restore();
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const updatePreferences = useCallback((changes) => {
    // Merge against the latest durable preferences so a second tab's different control is not
    // overwritten by this tab's older render. Persist before enabling automatic behavior.
    const saved = readForecastPreferences();
    const next = getValidatedForecastPreferences({ ...saved.preferences, ...changes });
    if (!next) {
      setWarning('Choose at least one supported fixed prediction time.');
      return;
    }
    const saveWarning = writeForecastPreferences(next);
    setWarning(saveWarning);
    setPreferences(saveWarning ? { ...saved.preferences, autoEnabled: false } : next);
  }, []);
  const setAutoEnabled = useCallback(
    (autoEnabled) => updatePreferences({ autoEnabled }),
    [updatePreferences],
  );
  const setCheckpointMinutes = useCallback(
    (checkpointMinutes) => updatePreferences({ checkpointMinutes }),
    [updatePreferences],
  );

  return { preferences, setAutoEnabled, setCheckpointMinutes, isRestored, warning };
}

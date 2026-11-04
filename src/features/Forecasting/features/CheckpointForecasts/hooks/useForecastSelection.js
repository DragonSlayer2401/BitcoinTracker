import { useState } from 'react';
import { useSelector } from 'react-redux';
import useForecastPreferences from './useForecastPreferences';
import {
  selectForecasts,
  selectActiveForecast,
  selectLatestForecast,
  selectScheduledForecast,
} from '@/features/Forecasting/state/selectors/forecastSelectors';

const useForecastSelection = () => {
  const controls = useForecastPreferences();
  const { autoEnabled } = controls.preferences;
  const [isPreparingForecast, setIsPreparingForecast] = useState(false);
  const [selectedMarketTicker, setSelectedMarketTicker] = useState(null);
  const scheduledForecast = useSelector(selectScheduledForecast);
  const forecasts = useSelector(selectForecasts);
  const activeForecast = useSelector(selectActiveForecast);
  const latestForecast = useSelector(selectLatestForecast);
  // Keep the saved call on screen until the user starts preparing another event.
  const recordedForecast =
    activeForecast ??
    (!isPreparingForecast && !scheduledForecast && !autoEnabled ? latestForecast : null);
  const preferredTicker =
    scheduledForecast?.marketTicker ?? (autoEnabled ? null : selectedMarketTicker);

  return {
    controls,
    forecasts,
    activeForecast,
    scheduledForecast,
    recordedForecast,
    preferredTicker,
    setSelectedMarketTicker,
    isPreparingForecast,
    setIsPreparingForecast,
  };
};
export default useForecastSelection;

import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import useKalshiSettlement from './useKalshiSettlement';
import { forecastsObserved } from '@/features/Forecasting/state/slices/forecastSlice';

const useForecastOutcomes = ({ forecasts, now, isReady }) => {
  const dispatch = useDispatch();
  const settlement = useKalshiSettlement({ forecasts, now, isReady });
  useEffect(() => {
    if (isReady && now && forecasts.length) {
      dispatch(forecastsObserved({ now, kalshiOutcomes: settlement.outcomes }));
    }
  }, [dispatch, isReady, now, forecasts, settlement.outcomes]);
  return settlement;
};
export default useForecastOutcomes;

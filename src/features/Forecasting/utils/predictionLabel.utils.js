import { OUTCOME_MODEL_VERSION } from '@/features/ForecastResearch/features/ModelLearning/utils/model.utils';
import { PRESSURE_MODEL_VERSION } from '@/features/Forecasting/features/LiveEstimates/utils/pressureForecast.utils';

export const getPredictionLabel = (forecast) => {
  if (forecast.kalshiMarket || forecast.kalshi) {
    if (!['above', 'below'].includes(forecast.direction)) return 'No directional edge';
    const prefix =
      Math.max(forecast.aboveProbability, forecast.belowProbability) < 0.55
        ? 'Slight lean'
        : 'Likely';
    return `${prefix} ${forecast.direction === 'above' ? 'Yes · at or above' : 'No · below'}`;
  }
  const usesPressure = [PRESSURE_MODEL_VERSION, OUTCOME_MODEL_VERSION].includes(
    forecast.modelVersion,
  );
  if (forecast.direction !== 'above' && forecast.direction !== 'below') {
    return usesPressure ? 'No directional edge' : 'Too close to call';
  }
  const hasSmallEdge =
    usesPressure && Math.max(forecast.aboveProbability, forecast.belowProbability) < 0.55;
  return `${hasSmallEdge ? 'Slight lean' : 'Likely'} ${forecast.direction}`;
};

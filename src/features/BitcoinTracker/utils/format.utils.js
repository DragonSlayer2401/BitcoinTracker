import { OUTCOME_MODEL_VERSION } from './learning/model.utils';
import { PRESSURE_MODEL_VERSION } from './pressureForecast.utils';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatPrice = (value) =>
  Number.isFinite(value) ? currencyFormatter.format(value) : '—';

export const formatPercent = (value, fractionDigits = 1) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(fractionDigits)}%` : '—';

export function getPredictionLabel(forecast) {
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
}

export const formatTime = (value) =>
  Number.isFinite(value)
    ? new Date(value).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

export function formatCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export const formatDateTime = (value) =>
  Number.isFinite(value)
    ? new Date(value).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
    : '—';

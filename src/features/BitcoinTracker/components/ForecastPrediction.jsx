import Icon from './Icon';
import { formatPercent, getPredictionLabel } from '../utils/format.utils';

export default function ForecastPrediction({
  forecast,
  label,
  caption,
  description,
  unavailableLabel = 'Estimate paused',
  compact = false,
}) {
  const directionLabel = getPredictionLabel(forecast);
  const inputCaption =
    forecast.calculationMode === 'baseline-fallback'
      ? 'Captured without a usable pressure fit'
      : forecast.calculationMode === 'pressure-adjusted'
        ? 'Captured with trade pressure'
        : forecast.pressure
          ? forecast.pressure.applied
            ? `Trade pressure ${forecast.pressure.direction === 'buy' ? 'toward Above' : forecast.pressure.direction === 'sell' ? 'toward Below' : 'balanced'}`
            : 'Baseline estimate · pressure still gathering or unavailable'
          : null;
  const inputLabel = forecast.calculationMode
    ? forecast.calculationMode === 'pressure-adjusted'
      ? 'Trade pressure'
      : 'Price only'
    : forecast.pressure?.applied
      ? forecast.pressure.direction === 'buy'
        ? 'Buying pressure'
        : forecast.pressure.direction === 'sell'
          ? 'Selling pressure'
          : 'Balanced pressure'
      : forecast.pressure
        ? 'Price only'
        : null;

  return (
    <section aria-label={label} className={compact ? 'live-estimate mt-2' : undefined}>
      <div
        className={`forecast-result ${forecast.available ? forecast.direction : 'unavailable'} ${compact ? 'd-flex flex-wrap justify-content-between align-items-center gap-2' : ''}`}
      >
        <div className="d-flex justify-content-between flex-wrap gap-1 small text-secondary">
          <span>
            {label}
            {!compact && forecast.available && inputLabel ? ` · ${inputLabel}` : ''}
          </span>
          <span title={forecast.available ? (inputCaption ?? undefined) : undefined}>
            {compact && forecast.available && inputLabel ? inputLabel : caption}
          </span>
        </div>
        <h3 className={`result-heading ${compact ? 'my-0' : 'mt-1 mb-0'}`}>
          {forecast.available && (
            <Icon
              name={
                forecast.direction === 'below'
                  ? 'down'
                  : forecast.direction === 'above'
                    ? 'up'
                    : 'activity'
              }
              size={compact ? 18 : 24}
            />
          )}
          {forecast.available ? directionLabel : unavailableLabel}
        </h3>
        {description && <p className="small text-secondary w-100 mt-1 mb-0">{description}</p>}
      </div>
      <div className="probability-labels d-flex justify-content-between mt-1 mb-1">
        <div>
          <span className="small text-secondary">Above target</span>
          <strong className="ms-2">{formatPercent(forecast.aboveProbability)}</strong>
        </div>
        <div className="text-end">
          <span className="small text-secondary">Below target</span>
          <strong className="ms-2">{formatPercent(forecast.belowProbability)}</strong>
        </div>
      </div>
      <div
        className={`probability-track ${forecast.available ? '' : 'unavailable'}`}
        role="img"
        aria-label={`Above target ${formatPercent(forecast.aboveProbability)}, below target ${formatPercent(forecast.belowProbability)}`}
      >
        <div
          className="probability-above"
          style={{ width: forecast.available ? `${forecast.aboveProbability * 100}%` : '0%' }}
        />
      </div>
    </section>
  );
}

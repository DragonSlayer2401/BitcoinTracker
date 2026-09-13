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
  const isKalshi = Boolean(forecast.kalshiMarket || forecast.kalshi);
  const aboveLabel = isKalshi ? 'Yes · at or above' : 'Above target';
  const belowLabel = isKalshi ? 'No · below' : 'Below target';
  const inputCaption = forecast.learning?.applied
    ? `Outcome model ${forecast.learning.modelId}`
    : forecast.derivatives?.applied
      ? 'Bybit futures activity changes the estimated Kalshi settlement probability'
      : forecast.calculationMode === 'baseline-fallback'
        ? 'Captured without a usable pressure fit'
        : forecast.calculationMode === 'pressure-adjusted'
          ? 'Captured with trade pressure'
          : forecast.pressure
            ? forecast.pressure.applied
              ? `Trade pressure ${forecast.pressure.direction === 'buy' ? 'toward Above' : forecast.pressure.direction === 'sell' ? 'toward Below' : 'balanced'}`
              : 'Baseline estimate · pressure still gathering or unavailable'
            : null;
  const inputLabel = forecast.learning?.applied
    ? 'Learned model'
    : forecast.derivatives?.applied
      ? 'Futures pressure'
      : forecast.calculationMode
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
          <span className="small text-secondary">{aboveLabel}</span>
          <strong className="ms-2">{formatPercent(forecast.aboveProbability)}</strong>
        </div>
        <div className="text-end">
          <span className="small text-secondary">{belowLabel}</span>
          <strong className="ms-2">{formatPercent(forecast.belowProbability)}</strong>
        </div>
      </div>
      <div
        className={`probability-track ${forecast.available ? '' : 'unavailable'}`}
        role="img"
        aria-label={`${aboveLabel} ${formatPercent(forecast.aboveProbability)}, ${belowLabel} ${formatPercent(forecast.belowProbability)}`}
      >
        <div
          className="probability-above"
          style={{ width: forecast.available ? `${forecast.aboveProbability * 100}%` : '0%' }}
        />
      </div>
    </section>
  );
}

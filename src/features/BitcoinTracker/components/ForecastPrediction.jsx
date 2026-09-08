import Icon from './Icon';
import { formatPercent } from '../utils/format.utils';

export default function ForecastPrediction({
  forecast,
  label,
  caption,
  description,
  unavailableLabel = 'Estimate paused',
  compact = false,
}) {
  const directionLabel =
    forecast.direction === 'above'
      ? 'Likely above'
      : forecast.direction === 'below'
        ? 'Likely below'
        : 'Too close to call';

  return (
    <section aria-label={label} className={compact ? 'live-estimate mt-2' : undefined}>
      <div
        className={`forecast-result ${forecast.available ? forecast.direction : 'unavailable'} ${compact ? 'd-flex flex-wrap justify-content-between align-items-center gap-2' : ''}`}
      >
        <div className="d-flex justify-content-between flex-wrap gap-1 small text-secondary">
          <span>{label}</span>
          <span>{caption}</span>
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

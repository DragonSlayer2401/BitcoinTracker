import ForecastPrediction from '../../components/ForecastPrediction';
import ForecastRisk from './components/ForecastRisk';
import { formatPercent, formatPrice } from '@/utils/format.utils';

const LiveEstimates = ({ now, marketData, recordedForecast, estimates }) => {
  const { ticker, stream, isLoading } = marketData;
  const { forecast, eventForecasts, riskForecast, savedRiskEstimate, savedRiskConditions } =
    estimates;
  const hasWindowEnded = recordedForecast && now >= recordedForecast.expiresAt;
  const hasBenchmark = forecast.kalshi?.referenceSource === 'cf-brti';
  const description =
    forecast.available || hasWindowEnded
      ? null
      : isLoading
        ? 'Waiting for fresh market data.'
        : forecast.reason || 'Waiting for fresh market data.';

  return (
    <>
      <ForecastPrediction
        forecast={forecast}
        label="Live estimate"
        caption={hasWindowEnded ? null : 'Kalshi close'}
        description={description}
        unavailableLabel={
          hasWindowEnded ? 'Window ended' : isLoading ? 'Connecting…' : 'Estimate paused'
        }
        compact={Boolean(recordedForecast || eventForecasts.length)}
      />
      <div className="d-flex justify-content-between align-items-center flex-wrap gap-1 mt-2 small text-secondary">
        {riskForecast ? (
          <ForecastRisk
            forecast={savedRiskEstimate}
            fixedForecast={riskForecast}
            ticker={ticker}
            now={now}
            stream={stream}
            conditions={savedRiskConditions}
          />
        ) : (
          'Model estimates · not yet validated'
        )}
      </div>
      {forecast.available && (
        <p className="small text-secondary mt-1 mb-0" role="status">
          {hasBenchmark
            ? 'BRTI benchmark connected'
            : 'Coinbase proxy · BRTI access needed for the settlement feed'}
        </p>
      )}
      {forecast.available && forecast.kalshi && (
        <details className="small mt-2">
          <summary>Settlement estimate details</summary>
          <dl className="window-summary small mt-2 mb-0">
            <div>
              <dt>Reference</dt>
              <dd>
                {formatPrice(forecast.kalshi.referencePrice)} · {hasBenchmark ? 'BRTI' : 'proxy'}
              </dd>
            </div>
            <div>
              <dt>Price history</dt>
              <dd>
                {forecast.kalshi.volatilitySource === 'cf-brti'
                  ? `BRTI · ${forecast.kalshi.benchmarkConditions?.features?.completedCandleCount ?? 0} complete minutes`
                  : 'Coinbase candles'}
              </dd>
            </div>
            <div>
              <dt>Minute volatility</dt>
              <dd>{formatPercent(forecast.kalshi.minuteVolatility, 3)}</dd>
            </div>
            <div>
              <dt>Final-minute readings</dt>
              <dd>{forecast.kalshi.observedSampleCount} / 60</dd>
            </div>
            <div>
              <dt>Missing elapsed readings</dt>
              <dd>{forecast.kalshi.missingElapsedSampleCount}</dd>
            </div>
            <div>
              <dt>Estimated average</dt>
              <dd>{formatPrice(forecast.kalshi.expectedSettlementAverage)}</dd>
            </div>
            {forecast.kalshi.futureSampleCount < 60 &&
              Number.isFinite(forecast.kalshi.requiredFutureAverage) && (
                <div>
                  <dt>Remaining average for Yes</dt>
                  <dd>{formatPrice(forecast.kalshi.requiredFutureAverage)}</dd>
                </div>
              )}
          </dl>
          <p className="text-secondary mt-1 mb-0">
            Model approximation. Kalshi’s official result determines settlement.
          </p>
        </details>
      )}
    </>
  );
};

export default LiveEstimates;

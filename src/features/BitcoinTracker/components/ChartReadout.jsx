import { formatDateTime, formatPrice, formatTime } from '../utils/format.utils';
import { getCandleDescription } from '../utils/priceChart.utils';

const indicatorValue = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');

/** Dock inspection above the plot so comparing candles never covers neighboring bars. */
export default function ChartReadout({
  point,
  view,
  indicators,
  indicatorCloseTime,
  comparison,
  showMacd,
  showRsi,
  showEma,
}) {
  const isCandle = view === 'candles';
  const description = point
    ? isCandle
      ? getCandleDescription(point)
      : `${formatDateTime(point.time)} · ${formatPrice(point.price)} · CF Benchmarks BRTI`
    : 'No observed reading at the crosshair.';
  const price = isCandle ? point?.close : point?.price;
  const comparisonPrice = comparison?.close ?? comparison?.price;
  const difference =
    Number.isFinite(price) && Number.isFinite(comparisonPrice) ? price - comparisonPrice : null;
  const isRising = point && isCandle ? point.close >= point.open : difference >= 0;
  const selectedValues = [
    ...(showEma ? [indicators?.ema9, indicators?.ema21] : []),
    ...(showMacd ? [indicators?.macd, indicators?.signal, indicators?.histogram] : []),
    ...(showRsi ? [indicators?.rsi] : []),
  ];
  const isWarmingUp = point && selectedValues.length > 0 && !selectedValues.some(Number.isFinite);
  return (
    <div className="trading-chart-readout">
      <output
        className="chart-point-readout d-block"
        aria-live="off"
        aria-label={description}
        title={description}
      >
        {point ? (
          <>
            <span className="chart-readout-time">{formatTime(point.time)}</span>{' '}
            {isCandle ? (
              <span className={`chart-ohlc ${isRising ? 'positive' : 'negative'}`}>
                <span>
                  O <b>{formatPrice(point.open)}</b>
                </span>{' '}
                <span>
                  H <b>{formatPrice(point.high)}</b>
                </span>{' '}
                <span>
                  L <b>{formatPrice(point.low)}</b>
                </span>{' '}
                <span>
                  C <b>{formatPrice(point.close)}</b>
                </span>
              </span>
            ) : (
              <strong>{formatPrice(point.price)}</strong>
            )}
            {point.isPartial && <span className="text-secondary"> · Partial candle</span>}
          </>
        ) : (
          <span className="text-secondary">No observed reading at the crosshair.</span>
        )}
      </output>
      <div className="chart-indicator-readout" aria-label="Indicator values at inspected candle">
        {indicatorCloseTime && (showMacd || showRsi || showEma) && (
          <span title={formatDateTime(indicatorCloseTime)}>
            Close {formatTime(indicatorCloseTime)}
          </span>
        )}
        {showEma && (
          <span className="ema-readout">
            EMA 9/21 {indicatorValue(indicators?.ema9)} / {indicatorValue(indicators?.ema21)}
          </span>
        )}
        {point?.isPartial && (showMacd || showRsi || showEma) && (
          <span>Indicators await a complete candle</span>
        )}
        {isWarmingUp && !point?.isPartial && <span>Warming up · complete candles required</span>}
      </div>
      {comparison && (
        <output
          className="chart-comparison-readout d-block"
          aria-live="off"
          aria-label="Pinned candle comparison"
        >
          Pinned {formatTime(comparison.time)} · {formatPrice(comparisonPrice)}
          {difference !== null && (
            <span className={difference >= 0 ? 'positive' : 'negative'}>
              {' '}
              · Δ {difference >= 0 ? '+' : ''}
              {formatPrice(difference)} ({difference >= 0 ? '+' : ''}
              {((difference / comparisonPrice) * 100).toFixed(3)}%)
            </span>
          )}
        </output>
      )}
    </div>
  );
}

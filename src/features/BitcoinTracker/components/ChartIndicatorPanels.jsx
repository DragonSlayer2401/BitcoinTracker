import { formatDateTime } from '../utils/format.utils';

const indicatorValue = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');

/** Panel headings share the plot's measured layout; they never intercept the crosshair. */
export default function ChartIndicatorPanels({ panels, indicators, indicatorCloseTime }) {
  return panels.map((panel) => (
    <section
      key={panel.id}
      aria-label={panel.label}
      className={`chart-indicator-panel indicator-${panel.id}`}
      style={{ top: panel.top, height: panel.height }}
    >
      <div className="chart-indicator-heading" style={{ height: panel.headerHeight }}>
        <h3>{panel.label}</h3>
        <output
          aria-live="off"
          aria-label={`${panel.id === 'macd' ? 'MACD' : 'RSI'} values at inspected candle`}
          title={`${panel.id === 'macd' ? 'MACD / signal / histogram' : 'Wilder RSI'}${indicatorCloseTime ? ` · Candle close ${formatDateTime(indicatorCloseTime)}` : ''}`}
        >
          {panel.id === 'macd' ? (
            <>
              MACD {indicatorValue(indicators?.macd)} / {indicatorValue(indicators?.signal)} /{' '}
              {indicatorValue(indicators?.histogram)}
            </>
          ) : (
            <>RSI 14 {indicatorValue(indicators?.rsi)}</>
          )}
        </output>
      </div>
    </section>
  ));
}

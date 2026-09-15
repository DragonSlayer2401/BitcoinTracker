import { Button, ButtonGroup } from 'react-bootstrap';

export default function ChartToolbar({
  view,
  onViewChange,
  candleMinutes,
  onCandleMinutesChange,
  windowMinutes,
  onWindowMinutesChange,
  showMacd,
  showRsi,
  showEma,
  onToggleIndicator,
}) {
  return (
    <div className="trading-chart-toolbar">
      <div className="d-flex align-items-center flex-wrap gap-2">
        <div>
          <span className="chart-option-label">Chart type</span>
          <ButtonGroup size="sm" aria-label="Chart view">
            {['line', 'candles'].map((value) => (
              <Button
                key={value}
                variant={view === value ? 'chart-active' : 'chart'}
                aria-pressed={view === value}
                onClick={() => onViewChange(value)}
              >
                {value === 'line' ? 'Line' : 'Candles'}
              </Button>
            ))}
          </ButtonGroup>
        </div>
        <div>
          <span className="chart-option-label">Candle interval</span>
          <ButtonGroup size="sm" aria-label="Candle interval">
            {[1, 3, 5, 15].map((minutes) => (
              <Button
                key={minutes}
                variant={candleMinutes === minutes ? 'chart-active' : 'chart'}
                aria-label={`${minutes} minute candles`}
                aria-pressed={candleMinutes === minutes}
                onClick={() => onCandleMinutesChange(minutes)}
              >
                {minutes}m
              </Button>
            ))}
          </ButtonGroup>
        </div>
      </div>
      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div>
          <span className="chart-option-label">History</span>
          <ButtonGroup size="sm" aria-label="Chart history">
            {[15, 30, 60, 120, 240].map((minutes) => (
              <Button
                key={minutes}
                variant={windowMinutes === minutes ? 'chart-active' : 'chart'}
                aria-pressed={windowMinutes === minutes}
                onClick={() => onWindowMinutesChange(minutes)}
              >
                {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
              </Button>
            ))}
          </ButtonGroup>
        </div>
        <div>
          <span className="chart-option-label">Indicators</span>
          <ButtonGroup size="sm" aria-label="Chart indicators">
            {[
              ['ema', 'EMA', showEma, 'Exponential moving averages, 9 and 21 periods'],
              ['macd', 'MACD', showMacd, 'MACD 12 / 26 with 9-period signal and histogram'],
              ['rsi', 'RSI', showRsi, 'Wilder RSI, 14 periods, levels 30 and 70'],
            ].map(([key, label, selected, title]) => (
              <Button
                key={key}
                variant={selected ? 'chart-active' : 'chart'}
                aria-pressed={selected}
                title={title}
                onClick={() => onToggleIndicator(key)}
              >
                {label}
              </Button>
            ))}
          </ButtonGroup>
        </div>
      </div>
    </div>
  );
}

import { useId, useState } from 'react';
import { Button, ButtonGroup } from 'react-bootstrap';
import { formatCountdown, formatPrice } from '../utils/format.utils';

const WIDTH = 800;
const HEIGHT = 292;
const LEFT = 12;
const RIGHT = 656;
const TOP = 25;
const BOTTOM = 250;
const minute = 60_000;

export default function PriceChart({
  candles = [],
  ticker,
  forecast,
  target,
  now,
  horizonMinutes = 15,
}) {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const gradientId = useId().replaceAll(':', '');
  const endTime = now || Date.now();
  const startTime = endTime - windowMinutes * minute;
  const futureMinutes =
    Number.isFinite(horizonMinutes) && horizonMinutes > 0 ? Math.min(15, horizonMinutes) : 0;
  const hasFutureWindow = futureMinutes > 0;
  const hasModelInterval = forecast.available && ticker && hasFutureWindow;
  const points = candles
    .filter((candle) => candle.time + minute >= startTime && candle.time + minute <= endTime)
    .map((candle) => ({ time: candle.time + minute, price: candle.close }));
  if (
    ticker &&
    ticker.time >= startTime &&
    ticker.time <= endTime &&
    (!points.length || ticker.time >= points.at(-1).time)
  ) {
    // Preserve newer candle history when the ticker feed is delayed.
    if (points.at(-1)?.time === ticker.time) points.pop();
    points.push({ time: ticker.time, price: ticker.price });
  }

  const prices = points.map((point) => point.price);
  if (hasModelInterval) prices.push(forecast.lowerBound, forecast.upperBound);
  const hasData = points.length > 1;
  let low = hasData ? Math.min(...prices) : 0;
  let high = hasData ? Math.max(...prices) : 1;
  const padding = Math.max((high - low) * 0.2, high * 0.0003);
  low -= padding;
  high += padding;
  const x = (time) =>
    LEFT + ((time - startTime) / ((windowMinutes + futureMinutes) * minute)) * (RIGHT - LEFT);
  const y = (price) => TOP + ((high - price) / (high - low)) * (BOTTOM - TOP);
  const path = points
    .map((point, index) => `${index ? 'L' : 'M'}${x(point.time)},${y(point.price)}`)
    .join(' ');
  const lastPoint = points.at(-1);
  const isPriceRising = !lastPoint || lastPoint.price >= points[0].price;
  const nowX = x(endTime);
  const hasVisibleTarget = Number.isFinite(target) && target >= low && target <= high;
  const timeLabel = (time) =>
    new Date(time).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  const cone = hasModelInterval
    ? Array.from({ length: 16 }, (_, index) => {
        const fraction = index / 15;
        const spread = 1.2815515655 * forecast.volatility * Math.sqrt(fraction);
        return {
          x: x(endTime + fraction * futureMinutes * minute),
          upper: y(ticker.price * Math.exp(spread)),
          lower: y(ticker.price * Math.exp(-spread)),
        };
      })
    : [];
  const conePath = cone.length
    ? `M${cone.map((point) => `${point.x},${point.upper}`).join(' L')} L${[...cone]
        .reverse()
        .map((point) => `${point.x},${point.lower}`)
        .join(' L')} Z`
    : '';

  return (
    <section
      className={`market-chart ${isPriceRising ? 'trend-up' : 'trend-down'}`}
      aria-labelledby="chart-heading"
    >
      <div className="chart-header d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
        <div>
          <h2 id="chart-heading" className="section-title mb-1">
            Price activity
          </h2>
          <span className="small text-secondary">One-minute closes · USD</span>
        </div>
        <ButtonGroup size="sm" aria-label="Chart history">
          {[30, 60, 120].map((minutes) => (
            <Button
              key={minutes}
              variant={minutes === windowMinutes ? 'chart-active' : 'chart'}
              onClick={() => setWindowMinutes(minutes)}
              aria-pressed={minutes === windowMinutes}
            >
              {minutes === 30 ? '30m' : `${minutes / 60}h`}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      {hasData ? (
        <figure className="m-0">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="price-chart"
            role="img"
            aria-labelledby={`${gradientId}-title ${gradientId}-description`}
          >
            <title id={`${gradientId}-title`}>
              Bitcoin price over the last {windowMinutes} minutes
            </title>
            <desc id={`${gradientId}-description`}>
              Latest displayed trade {formatPrice(ticker?.price)}. Target {formatPrice(target)}.
              {hasModelInterval
                ? `The shaded future area is the model's 80% range at the displayed endpoint (${formatCountdown(futureMinutes * minute)} remaining), ${formatPrice(forecast.lowerBound)} to ${formatPrice(forecast.upperBound)}; it is not a predicted path.`
                : 'The forecast is currently unavailable.'}
            </desc>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-line)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="var(--chart-line)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const price = high - fraction * (high - low);
              return (
                <g key={fraction}>
                  <line
                    x1={LEFT}
                    x2={RIGHT}
                    y1={y(price)}
                    y2={y(price)}
                    stroke="var(--chart-grid)"
                    strokeDasharray="3 5"
                  />
                  <text x={RIGHT + 12} y={y(price) + 4} className="chart-label chart-price-label">
                    {formatPrice(price)}
                  </text>
                </g>
              );
            })}
            {hasFutureWindow && (
              <rect
                x={nowX}
                y={TOP}
                width={RIGHT - nowX}
                height={BOTTOM - TOP}
                fill="var(--chart-future-bg)"
              />
            )}
            {conePath && (
              <path d={conePath} fill="var(--chart-cone)" opacity="0.18">
                <title>Model interval endpoint</title>
              </path>
            )}
            <path
              d={`${path} L${x(lastPoint.time)},${BOTTOM} L${x(points[0].time)},${BOTTOM} Z`}
              fill={`url(#${gradientId})`}
            />
            <path
              d={path}
              fill="none"
              stroke="var(--chart-line)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <line
              x1={nowX}
              x2={nowX}
              y1={TOP}
              y2={BOTTOM}
              stroke="var(--chart-grid)"
              strokeDasharray="3 4"
            />
            {hasVisibleTarget && (
              <line
                x1={LEFT}
                x2={RIGHT}
                y1={y(target)}
                y2={y(target)}
                stroke="var(--chart-target)"
                strokeDasharray="5 5"
              />
            )}
            <circle
              cx={x(lastPoint.time)}
              cy={y(lastPoint.price)}
              r="4"
              fill="var(--chart-line)"
              stroke="var(--chart-dot-outline)"
              strokeWidth="2"
            />
            <text x={LEFT} y={HEIGHT - 12} className="chart-label">
              {timeLabel(startTime)}
            </text>
            <text
              x={x(startTime + (windowMinutes / 2) * minute)}
              y={HEIGHT - 12}
              textAnchor="middle"
              className="chart-label"
            >
              {timeLabel(startTime + (windowMinutes / 2) * minute)}
            </text>
            <text x={nowX} y={HEIGHT - 12} textAnchor="end" className="chart-label">
              Now
            </text>
            {hasFutureWindow && (
              <text x={RIGHT + 12} y={HEIGHT - 12} className="chart-label">
                {futureMinutes < 15 ? 'End' : '+15m'}
              </text>
            )}
          </svg>
          <figcaption className="chart-legend d-flex flex-wrap align-items-center gap-3 small text-secondary">
            <span>
              <i className="legend-line" /> BTC/USD
            </span>
            <span>
              <i className="legend-line target" />{' '}
              {hasVisibleTarget ? 'Your target' : 'Target outside chart range'}
            </span>
            {hasModelInterval && (
              <span>
                <i className="legend-area" /> Model 80% range
              </span>
            )}
          </figcaption>
        </figure>
      ) : (
        <div className="chart-empty d-flex align-items-center justify-content-center text-secondary">
          Waiting for verified price history…
        </div>
      )}
    </section>
  );
}

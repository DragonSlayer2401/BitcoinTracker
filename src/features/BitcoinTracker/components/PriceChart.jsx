'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup } from 'react-bootstrap';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { formatCountdown, formatDateTime, formatPrice } from '../utils/format.utils';
import { getChartPoints, getPriceChartOption } from '../utils/priceChart.utils';
import './PriceChart.scss';

echarts.use([
  LineChart,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
]);

const MINUTE = 60_000;
const CHART_OPTIONS = { renderer: 'svg' };
const REPLACED_CHART_OPTIONS = ['series'];

export default function PriceChart({
  candles = [],
  ticker,
  forecast,
  target,
  now,
  horizonMinutes = 15,
}) {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [inspectedTime, setInspectedTime] = useState(null);
  const chartRef = useRef(null);
  const chartId = useId();
  const endTime = now || Date.now();
  const startTime = endTime - windowMinutes * MINUTE;
  const futureMinutes =
    Number.isFinite(horizonMinutes) && horizonMinutes > 0 ? Math.min(15, horizonMinutes) : 0;
  const points = useMemo(
    () => getChartPoints(candles, ticker, startTime, endTime),
    [candles, ticker, startTime, endTime],
  );
  const { option, hasModelInterval, hasVisibleTarget } = useMemo(
    () =>
      getPriceChartOption({ points, ticker, forecast, target, startTime, endTime, futureMinutes }),
    [points, ticker, forecast, target, startTime, endTime, futureMinutes],
  );
  const hasData = points.length > 1;
  const lastPoint = points.at(-1);
  const isPriceRising = !lastPoint || lastPoint.price >= points[0].price;
  const matchedIndex =
    inspectedTime === null ? -1 : points.findIndex((point) => point.time >= inspectedTime);
  const inspectedIndex = matchedIndex < 0 ? points.length - 1 : matchedIndex;
  const inspectedPoint = points[inspectedIndex];
  const pointDescription = inspectedPoint
    ? `${formatDateTime(inspectedPoint.time)} · ${formatPrice(inspectedPoint.price)} · ${inspectedPoint.source}`
    : '';
  const description = `Latest displayed ${lastPoint?.source.toLowerCase() || 'price'} ${formatPrice(lastPoint?.price)}. Preview target ${formatPrice(target)}. ${
    hasModelInterval
      ? `The shaded future area is the live model's 80% range at the displayed endpoint (${formatCountdown(futureMinutes * MINUTE)} remaining), ${formatPrice(forecast.lowerBound)} to ${formatPrice(forecast.upperBound)}; it updates with market data and is not the recorded prediction or a predicted path.`
      : 'The live model range is currently unavailable.'
  }`;

  function showHistoricalPoint(index) {
    chartRef.current?.getEchartsInstance()?.dispatchAction({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: index,
    });
  }

  return (
    <section
      className={`market-chart ${isPriceRising ? 'trend-up' : 'trend-down'}`}
      aria-labelledby={`${chartId}-heading`}
    >
      <div className="chart-header d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
        <div>
          <h2 id={`${chartId}-heading`} className="section-title mb-1">
            Price activity
          </h2>
          <span className="small text-secondary">One-minute closes + latest trade · USD</span>
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
          <div
            role="img"
            aria-label={`Bitcoin price over the last ${windowMinutes} minutes. ${description}`}
            className="price-chart-canvas"
          >
            <ReactEChartsCore
              ref={chartRef}
              echarts={echarts}
              option={option}
              opts={CHART_OPTIONS}
              className="price-chart-renderer"
              replaceMerge={REPLACED_CHART_OPTIONS}
            />
          </div>
          <div className="chart-inspection d-flex align-items-center gap-2">
            <input
              type="range"
              min="0"
              max={points.length - 1}
              step="1"
              value={inspectedIndex}
              aria-label="Inspect historical price points"
              aria-valuetext={pointDescription}
              aria-describedby={`${chartId}-instructions`}
              className="form-range mb-0"
              onFocus={() => showHistoricalPoint(inspectedIndex)}
              onChange={(event) => {
                const index = Number(event.target.value);
                setInspectedTime(points[index].time);
                showHistoricalPoint(index);
              }}
              onBlur={() =>
                chartRef.current?.getEchartsInstance()?.dispatchAction({ type: 'hideTip' })
              }
            />
            <output className="chart-point-readout" aria-live="off">
              {pointDescription}
            </output>
          </div>
          <figcaption className="chart-legend d-flex flex-wrap align-items-center gap-3 small text-secondary">
            <span>
              <i className="legend-line" /> BTC/USD
            </span>
            <span>
              <i className="legend-line target" />{' '}
              {hasVisibleTarget ? 'Preview target' : 'Target outside chart range'}
            </span>
            {hasModelInterval && (
              <span>
                <i className="legend-area" /> Live model 80% range
              </span>
            )}
            {futureMinutes > 0 && <span>{futureMinutes < 15 ? 'End' : '+15m'}</span>}
          </figcaption>
          <span id={`${chartId}-instructions`} className="visually-hidden">
            Hover or tap the chart for a price and timestamp. Use this slider's arrow keys to
            inspect each observed price.
          </span>
        </figure>
      ) : (
        <div className="chart-empty d-flex align-items-center justify-content-center text-secondary">
          Waiting for verified price history…
        </div>
      )}
    </section>
  );
}

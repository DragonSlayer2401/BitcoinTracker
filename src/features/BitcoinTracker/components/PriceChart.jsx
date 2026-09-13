'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup } from 'react-bootstrap';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { CandlestickChart, LineChart } from 'echarts/charts';
import {
  DataZoomInsideComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { formatCountdown, formatDateTime, formatPrice, formatTime } from '../utils/format.utils';
import { getBenchmarkSettlement } from '../utils/benchmarkChart.utils';
import { getCandleDescription, getPriceChartOption } from '../utils/priceChart.utils';
import useBenchmarkChartHistory from '../hooks/useBenchmarkChartHistory';
import './PriceChart.scss';

echarts.use([
  DataZoomInsideComponent,
  LineChart,
  CandlestickChart,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
]);

const MINUTE = 60_000;
const CHART_OPTIONS = { renderer: 'svg' };
const REPLACED_CHART_OPTIONS = ['series'];
const EMPTY_READINGS = [];

export default function PriceChart({ benchmarkData, forecast, target, now = 0, deadline }) {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [view, setView] = useState('line');
  const [inspectedTime, setInspectedTime] = useState(null);
  const [zoomRange, setZoomRange] = useState(null);
  const chartRef = useRef(null);
  const chartId = useId();
  const endTime = Number.isFinite(now) ? now : 0;
  const startTime = endTime - windowMinutes * MINUTE;
  const history = useBenchmarkChartHistory(benchmarkData, windowMinutes, endTime);
  const allReadings = history.chartData?.readings || EMPTY_READINGS;
  const allCandles = history.chartData?.candles || EMPTY_READINGS;
  const readings = useMemo(
    () => allReadings.filter((reading) => reading.time >= startTime && reading.time <= endTime),
    [allReadings, startTime, endTime],
  );
  const candles = useMemo(
    () =>
      allCandles.filter((candle) => candle.time >= startTime && candle.firstSampleAt <= endTime),
    [allCandles, startTime, endTime],
  );
  const settlement = useMemo(
    () => getBenchmarkSettlement(allReadings, deadline, endTime),
    [allReadings, deadline, endTime],
  );
  const { option, hasModelInterval, hasTarget, inspectionIndexes, visibleRange, isZoomed } =
    useMemo(
      () =>
        getPriceChartOption({
          readings,
          candles,
          view,
          forecast,
          target,
          startTime,
          endTime,
          deadline,
          settlement,
          zoomRange,
        }),
      [
        readings,
        candles,
        view,
        forecast,
        target,
        startTime,
        endTime,
        deadline,
        settlement,
        zoomRange,
      ],
    );
  const allObservations = view === 'candles' ? candles : readings;
  const visibleIndexes = allObservations.reduce((indexes, point, index) => {
    if (point.time >= visibleRange.startTime && point.time <= visibleRange.endTime)
      indexes.push(index);
    return indexes;
  }, []);
  const observations = visibleIndexes.map((index) => allObservations[index]);
  const hasData = allObservations.length > 0;
  // ECharts has already resolved wheel/pinch/drag gestures to timestamps. Store those
  // timestamps so incoming data cannot shift the section being inspected.
  const chartEvents = useMemo(
    () => ({
      datazoom: (_event, instance) => {
        const range = instance.getOption().dataZoom?.find((item) => item.id === 'time-zoom');
        if (
          !Number.isFinite(range?.startValue) ||
          !Number.isFinite(range?.endValue) ||
          range.endValue <= range.startValue
        )
          return;
        setZoomRange(
          range.start <= 0 && range.end >= 100
            ? null
            : {
                startTime: range.startValue,
                endTime: range.endValue,
              },
        );
      },
    }),
    [],
  );
  const lastPoint = readings.at(-1);
  const isPriceRising = !lastPoint || lastPoint.price >= readings[0].price;
  const matchedIndex =
    inspectedTime === null ? -1 : observations.findIndex((point) => point.time >= inspectedTime);
  const inspectedIndex = matchedIndex < 0 ? observations.length - 1 : matchedIndex;
  const inspectedPoint = observations[inspectedIndex];
  const pointDescription = !inspectedPoint
    ? ''
    : view === 'candles'
      ? getCandleDescription(inspectedPoint)
      : `${formatDateTime(inspectedPoint.time)} · ${formatPrice(inspectedPoint.price)} · CF Benchmarks BRTI`;
  const status = history.chartData?.status || 'unavailable';
  const description = `Latest displayed BRTI ${formatPrice(lastPoint?.price)} at ${formatDateTime(lastPoint?.time)}. Kalshi target ${formatPrice(target)}. ${status === 'live' ? 'Live BRTI readings.' : 'BRTI is unavailable or stale; displayed history is not a live quote.'} ${hasModelInterval ? `The vertical interval at the actual deadline is the live model's 80% settlement-average range (${formatCountdown(deadline - endTime)} remaining), ${formatPrice(forecast.kalshi.settlementLowerBound)} to ${formatPrice(forecast.kalshi.settlementUpperBound)}. It is not the recorded prediction or an observed future price.` : 'The live model range is currently unavailable.'}`;

  function showHistoricalPoint(index) {
    chartRef.current?.getEchartsInstance()?.dispatchAction({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: inspectionIndexes[visibleIndexes[index]],
    });
  }

  function changeZoom(scale, shift = 0) {
    const span = visibleRange.endTime - visibleRange.startTime;
    if (span * scale >= option.xAxis.max - startTime) {
      setZoomRange(null);
      return;
    }
    const center = (visibleRange.startTime + visibleRange.endTime) / 2 + span * shift;
    setZoomRange({ startTime: center - (span * scale) / 2, endTime: center + (span * scale) / 2 });
  }

  return (
    <section
      className={`market-chart ${isPriceRising ? 'trend-up' : 'trend-down'}`}
      aria-labelledby={`${chartId}-heading`}
    >
      <div className="chart-header d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
        <div>
          <h2 id={`${chartId}-heading`} className="section-title mb-1">
            BRTI price activity
          </h2>
          <span
            className={`small ${status === 'live' ? 'text-secondary' : 'text-warning'}`}
            title={history.chartData?.reason || undefined}
          >
            CF Benchmarks · {view === 'candles' ? '1m candles' : 'Index readings'} ·{' '}
            {status === 'live' ? 'Live' : status === 'stale' ? 'Stale history' : 'Unavailable'}
          </span>
        </div>
        <div className="d-flex align-items-center flex-wrap gap-2">
          <ButtonGroup size="sm" aria-label="Chart view">
            {[
              ['line', 'Line'],
              ['candles', 'Candles'],
            ].map(([value, label]) => (
              <Button
                key={value}
                variant={value === view ? 'chart-active' : 'chart'}
                aria-pressed={view === value}
                onClick={() => {
                  setView(value);
                  setInspectedTime(null);
                }}
              >
                {label}
              </Button>
            ))}
          </ButtonGroup>
          <ButtonGroup size="sm" aria-label="Chart history">
            {[15, 30, 60, 120, 240].map((minutes) => (
              <Button
                key={minutes}
                variant={minutes === windowMinutes ? 'chart-active' : 'chart'}
                onClick={() => {
                  setWindowMinutes(minutes);
                  setZoomRange(null);
                  setInspectedTime(null);
                }}
                aria-pressed={minutes === windowMinutes}
              >
                {minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}
              </Button>
            ))}
          </ButtonGroup>
        </div>
      </div>
      {history.notice && (
        <div
          className="small text-secondary mb-1 d-flex align-items-center flex-wrap gap-2"
          role="status"
        >
          <span>{history.notice}</span>
          {history.canRetry && (
            <Button variant="outline-secondary" size="sm" onClick={history.retry}>
              Retry history
            </Button>
          )}
        </div>
      )}
      {hasData ? (
        <figure className="m-0">
          <div className="price-chart-frame position-relative">
            <div
              role="img"
              aria-label={`Bitcoin BRTI ${view === 'candles' ? 'candles' : 'price'} over the last ${windowMinutes} minutes. Visible range ${formatDateTime(visibleRange.startTime)} to ${formatDateTime(visibleRange.endTime)}. ${description}`}
              className="price-chart-canvas"
            >
              <ReactEChartsCore
                ref={chartRef}
                echarts={echarts}
                option={option}
                opts={CHART_OPTIONS}
                className="price-chart-renderer"
                replaceMerge={REPLACED_CHART_OPTIONS}
                onEvents={chartEvents}
              />
            </div>
            <div className="chart-navigation" title="Scroll or pinch to zoom · drag to pan">
              <ButtonGroup size="sm" aria-label="Chart zoom and pan">
                <Button
                  variant="chart"
                  aria-label="Pan earlier"
                  title="Pan earlier"
                  disabled={!isZoomed || visibleRange.startTime <= startTime}
                  onClick={() => changeZoom(1, -0.5)}
                >
                  ←
                </Button>
                <Button
                  variant="chart"
                  aria-label="Zoom out"
                  title="Zoom out"
                  disabled={!isZoomed}
                  onClick={() => changeZoom(2)}
                >
                  −
                </Button>
                <Button
                  variant="chart"
                  aria-label="Zoom in"
                  title="Zoom in"
                  disabled={visibleRange.endTime - visibleRange.startTime <= MINUTE}
                  onClick={() => changeZoom(0.5)}
                >
                  +
                </Button>
                <Button
                  variant="chart"
                  aria-label="Pan later"
                  title="Pan later"
                  disabled={!isZoomed || visibleRange.endTime >= option.xAxis.max}
                  onClick={() => changeZoom(1, 0.5)}
                >
                  →
                </Button>
                <Button
                  variant="chart"
                  aria-label="Reset zoom"
                  disabled={!isZoomed}
                  onClick={() => setZoomRange(null)}
                >
                  Reset
                </Button>
              </ButtonGroup>
            </div>
          </div>
          {observations.length > 0 ? (
            <div className="chart-inspection d-flex align-items-center gap-2">
              <input
                type="range"
                min="0"
                max={observations.length - 1}
                step="1"
                value={inspectedIndex}
                aria-label={
                  view === 'candles' ? 'Inspect BRTI candles' : 'Inspect historical BRTI readings'
                }
                aria-valuetext={pointDescription}
                aria-describedby={`${chartId}-instructions`}
                className="form-range mb-0"
                onFocus={() => showHistoricalPoint(inspectedIndex)}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setInspectedTime(observations[index].time);
                  showHistoricalPoint(index);
                }}
                onBlur={() =>
                  chartRef.current?.getEchartsInstance()?.dispatchAction({ type: 'hideTip' })
                }
              />
              <output
                className="chart-point-readout"
                aria-live="off"
                aria-label={pointDescription}
                title={pointDescription}
              >
                {formatTime(inspectedPoint.time)} ·{' '}
                {formatPrice(view === 'candles' ? inspectedPoint.close : inspectedPoint.price)}
                {view === 'candles' && inspectedPoint.isPartial ? ' · Partial candle' : ''}
              </output>
            </div>
          ) : (
            <p className="small text-secondary mb-1">
              No observed readings in this zoomed section.
            </p>
          )}
          <figcaption className="chart-legend d-flex flex-wrap align-items-center gap-3 small text-secondary">
            <span>
              <i className="legend-line" /> BRTI
              {view === 'candles' ? ' · dim candles are partial' : ''}
            </span>
            {hasTarget && (
              <span>
                <i className="legend-line target" /> Kalshi target {formatPrice(target)}
              </span>
            )}
            {Number.isFinite(deadline) && deadline > startTime && (
              <span title={formatDateTime(deadline)}>
                <i className="legend-area settlement" /> Final minute · {formatTime(deadline)}
              </span>
            )}
            {hasModelInterval && (
              <span>
                <i className="legend-line target" /> 80% settlement range
              </span>
            )}
          </figcaption>
          {settlement.sampleCount > 0 && (
            <p className="chart-settlement-note small text-secondary mb-0 mt-1">
              <span className="settlement-average-label">
                Observed final-minute average {formatPrice(settlement.average)}
              </span>{' '}
              · {settlement.sampleCount}/60 samples{!settlement.isComplete ? ' · Incomplete' : ''}.
              Official settlement is confirmed separately.
            </p>
          )}
          <span id={`${chartId}-instructions`} className="visually-hidden">
            Hover or tap the chart for exact observed values and timestamps. Use this slider's arrow
            keys to inspect each{' '}
            {view === 'candles' ? 'candle and its observed sample coverage' : 'BRTI reading'}.
            Scroll or pinch to zoom, drag to pan, or use the chart zoom and pan buttons. Missing
            readings are not filled.
          </span>
        </figure>
      ) : (
        <div className="chart-empty d-flex align-items-center justify-content-center text-secondary">
          Waiting for CF Benchmarks BRTI history…
        </div>
      )}
    </section>
  );
}

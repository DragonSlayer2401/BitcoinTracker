'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, ButtonGroup, Modal } from 'react-bootstrap';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
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
import { aggregateChartCandles, getChartIndicators } from '../utils/chartIndicators.utils';
import useBenchmarkChartHistory from '../hooks/useBenchmarkChartHistory';
import useChartDrawings from '../hooks/useChartDrawings';
import useChartDrawingInteraction from '../hooks/useChartDrawingInteraction';
import ChartDrawingControls from './ChartDrawingControls';
import ChartReadout from './ChartReadout';
import ChartIndicatorPanels from './ChartIndicatorPanels';
import ChartToolbar from './ChartToolbar';
import './PriceChart.scss';

echarts.use([
  AxisPointerComponent,
  DataZoomInsideComponent,
  LineChart,
  CandlestickChart,
  BarChart,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  SVGRenderer,
]);
const MINUTE = 60_000;
const CHART_OPTIONS = { renderer: 'svg' };
const REPLACED_CHART_OPTIONS = ['series', 'grid', 'xAxis', 'yAxis'];
const EMPTY_READINGS = [];

function nearestObservationIndex(points, time, maximumDistance) {
  let best = -1;
  let distance = maximumDistance;
  points.forEach((point, index) => {
    const nextDistance = Math.abs(point.time - time);
    if (nextDistance <= distance) {
      best = index;
      distance = nextDistance;
    }
  });
  return best;
}

export default function PriceChart({ benchmarkData, forecast, target, now = 0, deadline }) {
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [view, setView] = useState('candles');
  const [candleMinutes, setCandleMinutes] = useState(1);
  const [enabledIndicators, setEnabledIndicators] = useState({ macd: true, rsi: true, ema: false });
  const [inspectedTime, setInspectedTime] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [zoomRange, setZoomRange] = useState(null);
  const [activeTool, setActiveTool] = useState('select');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const [chart, setChart] = useState(null);
  const [chartHeight, setChartHeight] = useState(240);
  const chartRef = useRef(null);
  const expandButtonRef = useRef(null);
  const wasExpanded = useRef(false);
  const canvasRef = useRef(null);
  const chartId = useId();
  const drawingState = useChartDrawings();
  const { draftDrawing, isChoosingEnd } = useChartDrawingInteraction({
    chart,
    activeTool,
    onToolChange: setActiveTool,
    addDrawing: drawingState.addDrawing,
  });
  const endTime = Number.isFinite(now) ? now : 0;
  const startTime = endTime - windowMinutes * MINUTE;
  const history = useBenchmarkChartHistory(benchmarkData, windowMinutes, endTime);
  const allReadings = history.chartData?.readings || EMPTY_READINGS;
  const allCandles = history.chartData?.candles || EMPTY_READINGS;
  const aggregatedCandles = useMemo(
    () => aggregateChartCandles(allCandles, candleMinutes, endTime),
    [allCandles, candleMinutes, endTime],
  );
  // Warm up indicators on all loaded candles, not just the zoomed or selected display range.
  const indicators = useMemo(
    () => getChartIndicators(aggregatedCandles, { intervalMinutes: candleMinutes }),
    [aggregatedCandles, candleMinutes],
  );
  const readings = useMemo(
    () => allReadings.filter((reading) => reading.time >= startTime && reading.time <= endTime),
    [allReadings, startTime, endTime],
  );
  const candles = useMemo(
    () =>
      aggregatedCandles.filter(
        (candle) => candle.time >= startTime && candle.firstSampleAt <= endTime,
      ),
    [aggregatedCandles, startTime, endTime],
  );
  const settlement = useMemo(
    () => getBenchmarkSettlement(allReadings, deadline, endTime),
    [allReadings, deadline, endTime],
  );
  const annotations = useMemo(
    () => (draftDrawing ? [...drawingState.drawings, draftDrawing] : drawingState.drawings),
    [drawingState.drawings, draftDrawing],
  );
  const {
    option,
    axisEndTime,
    hasModelInterval,
    hasTarget,
    inspectionIndexes,
    visibleRange,
    isZoomed,
    indicatorPanels = [],
  } = useMemo(
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
        indicators,
        showMacd: enabledIndicators.macd,
        showRsi: enabledIndicators.rsi,
        showEma: enabledIndicators.ema,
        annotations,
        isDrawing: activeTool !== 'select',
        candleMinutes,
        comparisonTime: comparison?.time ?? null,
        chartHeight,
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
      indicators,
      enabledIndicators,
      annotations,
      activeTool,
      candleMinutes,
      comparison,
      chartHeight,
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
  const inspectedIndex =
    inspectedTime === null
      ? observations.length - 1
      : nearestObservationIndex(
          observations,
          inspectedTime,
          view === 'candles' ? (candleMinutes * MINUTE) / 2 : 1000,
        );
  const inspectedPoint = observations[inspectedIndex];
  const inspectedCandle =
    view === 'candles'
      ? inspectedPoint
      : aggregatedCandles.findLast(
          (candle) =>
            inspectedPoint &&
            candle.endTime <= inspectedPoint.time &&
            candle.endTime > inspectedPoint.time - candleMinutes * MINUTE,
        );
  const inspectedIndicators = indicators.points.find(
    (point) => point.time === inspectedCandle?.time,
  );
  const indicatorCloseTimeForPanel = inspectedCandle?.endTime;
  const pointDescription = !inspectedPoint
    ? ''
    : view === 'candles'
      ? getCandleDescription(inspectedPoint)
      : `${formatDateTime(inspectedPoint.time)} · ${formatPrice(inspectedPoint.price)} · CF Benchmarks BRTI`;
  const lastPoint = readings.at(-1);
  const isPriceRising = !lastPoint || lastPoint.price >= readings[0].price;
  const status = history.chartData?.status || 'unavailable';
  const description = `Latest displayed BRTI ${formatPrice(lastPoint?.price)} at ${formatDateTime(lastPoint?.time)}. Kalshi target ${formatPrice(target)}. ${status === 'live' ? 'Live BRTI readings.' : 'BRTI is unavailable or stale; displayed history is not a live quote.'} ${hasModelInterval ? `The vertical interval at the actual deadline is the live model's 80% settlement-average range (${formatCountdown(deadline - endTime)} remaining), ${formatPrice(forecast.kalshi.settlementLowerBound)} to ${formatPrice(forecast.kalshi.settlementUpperBound)}. It is not the recorded prediction or an observed future price.` : 'The live model range is currently unavailable.'}`;

  useEffect(() => {
    if (wasExpanded.current && !isExpanded) expandButtonRef.current?.focus();
    wasExpanded.current = isExpanded;
  }, [isExpanded]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const height = Math.round(entry.contentRect.height);
      if (height > 0) setChartHeight(height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasData, isExpanded]);

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
            : { startTime: range.startValue, endTime: range.endValue },
        );
      },
      updateAxisPointer: (event) => {
        const axis = event.axesInfo?.find((item) => item.axisDim === 'x');
        if (Number.isFinite(axis?.value)) setInspectedTime(axis.value);
      },
    }),
    [],
  );

  function showHistoricalPoint(index) {
    chartRef.current?.getEchartsInstance()?.dispatchAction({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: inspectionIndexes[visibleIndexes[index]],
    });
  }
  function changeZoom(scale, shift = 0) {
    const span = visibleRange.endTime - visibleRange.startTime;
    if (span * scale >= axisEndTime - startTime) {
      setZoomRange(null);
      return;
    }
    const center = (visibleRange.startTime + visibleRange.endTime) / 2 + span * shift;
    setZoomRange({ startTime: center - (span * scale) / 2, endTime: center + (span * scale) / 2 });
  }
  const changeView = (next) => {
    setView(next);
    setInspectedTime(null);
    setComparison(null);
  };
  const changeInterval = (minutes) => {
    setCandleMinutes(minutes);
    setInspectedTime(null);
    setComparison(null);
  };
  const changeHistory = (minutes) => {
    setWindowMinutes(minutes);
    setZoomRange(null);
    setInspectedTime(null);
  };
  const onChartReady = useCallback((instance) => setChart(instance), []);
  const closeExpanded = () => {
    setActiveTool('select');
    setIsExpanded(false);
    setChart(null);
  };
  const handleKeyDown = (event) => {
    if (event.key === 'Escape' && activeTool !== 'select') {
      event.stopPropagation();
      setActiveTool('select');
    }
  };

  const drawingProps = {
    drawings: drawingState.drawings,
    onAdd: drawingState.addDrawing,
    onUpdate: drawingState.updateDrawing,
    onRemove: drawingState.removeDrawing,
    onUndo: drawingState.undoLast,
    onClear: drawingState.clearDrawings,
    canUndo: drawingState.canUndo,
    activeTool,
    onToolChange: (tool) => {
      setActiveTool(tool);
      if (tool !== 'select') setIsToolsOpen(false);
    },
    defaultPrice: inspectedPoint?.close ?? inspectedPoint?.price ?? lastPoint?.price ?? target,
    defaultTime: inspectedPoint?.time ?? endTime,
    disabled: !drawingState.isRestored,
  };
  const zoomControls = (
    <ButtonGroup size="sm" aria-label="Chart zoom and pan">
      <Button
        variant="chart"
        aria-label="Pan earlier"
        title="Pan earlier"
        disabled={activeTool !== 'select' || !isZoomed || visibleRange.startTime <= startTime}
        onClick={() => changeZoom(1, -0.5)}
      >
        ←
      </Button>
      <Button
        variant="chart"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={activeTool !== 'select' || !isZoomed}
        onClick={() => changeZoom(2)}
      >
        −
      </Button>
      <Button
        variant="chart"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={
          activeTool !== 'select' || visibleRange.endTime - visibleRange.startTime <= MINUTE
        }
        onClick={() => changeZoom(0.5)}
      >
        +
      </Button>
      <Button
        variant="chart"
        aria-label="Pan later"
        title="Pan later"
        disabled={activeTool !== 'select' || !isZoomed || visibleRange.endTime >= axisEndTime}
        onClick={() => changeZoom(1, 0.5)}
      >
        →
      </Button>
      <Button
        variant="chart"
        aria-label="Reset zoom"
        disabled={activeTool !== 'select' || !isZoomed}
        onClick={() => {
          setZoomRange(null);
          setInspectedTime(null);
        }}
      >
        Reset
      </Button>
    </ButtonGroup>
  );

  const toolsContent = (
    <>
      <h3 className="h6">Display and indicators</h3>
      <ChartToolbar
        view={view}
        onViewChange={changeView}
        candleMinutes={candleMinutes}
        onCandleMinutesChange={changeInterval}
        windowMinutes={windowMinutes}
        onWindowMinutesChange={changeHistory}
        showMacd={enabledIndicators.macd}
        showRsi={enabledIndicators.rsi}
        showEma={enabledIndicators.ema}
        onToggleIndicator={(name) =>
          setEnabledIndicators((current) => ({ ...current, [name]: !current[name] }))
        }
      />
      <div className="chart-tools-content">
        <ChartDrawingControls mode="tools" {...drawingProps} />
      </div>

      <h3 className="h6 mt-4">Candle comparison</h3>
      <p className="small text-secondary mb-2">
        Pin the inspected price, then inspect another candle to see the dollar and percentage
        change.
      </p>
      <Button
        size="sm"
        variant="chart"
        disabled={!inspectedPoint}
        aria-pressed={Boolean(comparison)}
        onClick={() => {
          setComparison(comparison ? null : { ...inspectedPoint });
          setIsToolsOpen(false);
        }}
      >
        {comparison ? 'Clear comparison' : 'Pin comparison'}
      </Button>
    </>
  );

  const content = (
    <>
      <div className="chart-header d-flex justify-content-between align-items-center gap-2 mb-1">
        <div className="d-flex flex-wrap align-items-baseline gap-2">
          <h2 id={`${chartId}-heading`} className="section-title mb-0">
            BRTI price activity
          </h2>
          <span
            className={`chart-source ${status === 'live' ? 'text-secondary' : 'text-warning'}`}
            title={history.chartData?.reason || undefined}
          >
            CF Benchmarks · {view === 'candles' ? `${candleMinutes}m candles` : 'Index readings'} ·{' '}
            {status === 'live' ? 'Live' : status === 'stale' ? 'Stale history' : 'Unavailable'}
          </span>
        </div>
        <div className="d-flex align-items-center gap-1">
          <ChartDrawingControls mode="manager" {...drawingProps} />
          <Button
            variant="chart"
            size="sm"
            aria-label="Chart tools"
            aria-haspopup="dialog"
            aria-expanded={isToolsOpen}
            onClick={() => setIsToolsOpen(true)}
          >
            Tools
          </Button>
          <Button
            variant="chart"
            size="sm"
            aria-label={isExpanded ? 'Restore chart' : 'Expand chart'}
            className="chart-expand-button"
            ref={expandButtonRef}
            title={isExpanded ? 'Restore chart' : 'Expand chart'}
            onClick={() => {
              setActiveTool('select');
              setChart(null);
              setIsExpanded((value) => !value);
            }}
          >
            {isExpanded ? '↙' : '⛶'}
          </Button>
        </div>
      </div>
      {activeTool !== 'select' && (
        <p className="chart-tool-notice mb-0" role="status">
          {activeTool === 'trend'
            ? isChoosingEnd
              ? 'Click the ending point.'
              : 'Click two points for a trend line.'
            : activeTool === 'horizontal'
              ? 'Click the price chart to place a horizontal line.'
              : 'Click the price chart to place a vertical line.'}{' '}
          <Button size="sm" variant="chart" onClick={() => setActiveTool('select')}>
            Cancel drawing
          </Button>
        </p>
      )}
      {drawingState.warning && (
        <p className="small text-warning mb-0" role="alert">
          {drawingState.warning}
        </p>
      )}
      {history.notice && (
        <div
          className="small text-secondary d-flex align-items-center flex-wrap gap-2"
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
          <ChartReadout
            point={inspectedPoint}
            view={view}
            indicators={inspectedIndicators}
            indicatorCloseTime={view === 'line' ? inspectedCandle?.endTime : null}
            comparison={comparison}
            showMacd={enabledIndicators.macd}
            showRsi={enabledIndicators.rsi}
            showEma={enabledIndicators.ema}
          />
          <div
            className={`price-chart-frame position-relative ${activeTool !== 'select' ? 'drawing-active' : ''}`}
          >
            <ChartIndicatorPanels
              panels={indicatorPanels}
              indicators={inspectedIndicators}
              indicatorCloseTime={indicatorCloseTimeForPanel}
            />
            <div
              ref={canvasRef}
              role="img"
              tabIndex={0}
              aria-describedby={`${chartId}-instructions`}
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
                onChartReady={onChartReady}
              />
            </div>
          </div>
          {observations.length > 0 ? (
            <div className="chart-inspection d-flex align-items-center justify-content-between gap-2">
              <input
                type="range"
                min="0"
                max={observations.length - 1}
                step="1"
                value={Math.max(0, inspectedIndex)}
                aria-label={
                  view === 'candles' ? 'Inspect BRTI candles' : 'Inspect historical BRTI readings'
                }
                aria-valuetext={pointDescription}
                aria-describedby={`${chartId}-instructions`}
                className="form-range mb-0"
                onFocus={() => showHistoricalPoint(Math.max(0, inspectedIndex))}
                onChange={(event) => {
                  const index = Number(event.target.value);
                  setInspectedTime(observations[index].time);
                  showHistoricalPoint(index);
                }}
                onBlur={() =>
                  chartRef.current?.getEchartsInstance()?.dispatchAction({ type: 'hideTip' })
                }
              />

              {zoomControls}
            </div>
          ) : (
            <div className="chart-inspection d-flex flex-wrap align-items-center justify-content-between gap-2">
              <span>No observed readings in this zoomed section.</span>
              {zoomControls}
            </div>
          )}
          <figcaption className="chart-legend d-flex flex-wrap align-items-center gap-3 small text-secondary">
            <span>
              <i className="legend-line" /> BRTI
              {view === 'candles' ? ' · dim candles are partial' : ''}
            </span>
            {hasTarget && (
              <span>
                <i className="legend-line target" /> Target {formatPrice(target)}
              </span>
            )}
            {Number.isFinite(deadline) && deadline > startTime && (
              <span title={formatDateTime(deadline)}>
                <i className="legend-area settlement" /> Final minute · {formatTime(deadline)}
              </span>
            )}
            {hasModelInterval && (
              <span title="Live model 80% settlement-average range">
                <i className="legend-line target" /> 80% range
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
            Hover or tap the chart to inspect values in the fixed readout above. Use this slider's
            arrow keys to compare each{' '}
            {view === 'candles' ? 'candle and its observed sample coverage' : 'BRTI reading'}. Pin
            one observation to compare it with another. Scroll or pinch to zoom, drag to pan.
            Drawing tools place horizontal and vertical lines with one click, or a trend line with
            two clicks. Tools contains drawing placement, indicators, and comparison controls.
            Drawings lists saved lines with exact editing, individual deletion, and Clear all
            drawings. Zoom and pan controls are directly below the plot. Missing readings are not
            filled. Indicators use complete observed candles, with no values during warmup or
            missing data, and do not change the prediction model.
          </span>
        </figure>
      ) : (
        <>
          <div className="chart-empty d-flex align-items-center justify-content-center text-secondary">
            Waiting for CF Benchmarks BRTI history…
          </div>
          <div className="chart-inspection d-flex justify-content-end">{zoomControls}</div>
        </>
      )}
    </>
  );
  return (
    <section
      className={`market-chart trading-chart ${isPriceRising ? 'trend-up' : 'trend-down'}`}
      aria-labelledby={`${chartId}-heading`}
      onKeyDown={handleKeyDown}
    >
      {isExpanded ? (
        <>
          <div className="chart-expanded-placeholder text-secondary">Chart is expanded.</div>
          <Modal
            show
            fullscreen
            onHide={closeExpanded}
            className="tracker-modal chart-focus-modal"
            aria-labelledby={`${chartId}-heading`}
          >
            <Modal.Body className="bitcoin-tracker p-3" onKeyDown={handleKeyDown}>
              <div
                className={`market-chart trading-chart expanded-chart ${isPriceRising ? 'trend-up' : 'trend-down'}`}
              >
                {content}
              </div>
            </Modal.Body>
          </Modal>
        </>
      ) : (
        content
      )}
      {isToolsOpen && (
        <Modal
          show
          onHide={() => setIsToolsOpen(false)}
          centered
          scrollable
          size="lg"
          className="tracker-modal chart-tools-modal"
          aria-labelledby={chartId + '-tools-heading'}
        >
          <Modal.Header closeButton>
            <Modal.Title id={chartId + '-tools-heading'} className="h5">
              Chart tools
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>{toolsContent}</Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" size="sm" onClick={() => setIsToolsOpen(false)}>
              Done
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </section>
  );
}

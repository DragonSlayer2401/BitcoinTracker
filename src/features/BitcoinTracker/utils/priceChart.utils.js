import { formatDateTime, formatPrice } from './format.utils';

const MINUTE = 60_000;
const GREEN = '#4de6a2';
const RED = '#ff7a88';
const AVERAGE_COLOR = '#80c7ff';

/** Keep a selected time window inside the loaded chart, with at least one minute visible. */
export function getChartZoomRange(range, startTime, endTime) {
  const fullSpan = endTime - startTime;
  if (
    !range ||
    !Number.isFinite(range.startTime) ||
    !Number.isFinite(range.endTime) ||
    range.endTime <= range.startTime ||
    fullSpan <= 0
  ) {
    return { startTime, endTime };
  }
  const span = Math.min(fullSpan, Math.max(MINUTE, range.endTime - range.startTime));
  const center = (range.startTime + range.endTime) / 2;
  const start = Math.max(startTime, Math.min(endTime - span, center - span / 2));
  return { startTime: start, endTime: start + span };
}

// Keep absent seconds visible without turning them into observations for inspection.
export function getObservedLineData(readings) {
  const data = [];
  const inspectionIndexes = [];
  readings.forEach((reading, index) => {
    const previous = readings[index - 1];
    const next = readings[index + 1];
    if (previous && reading.time - previous.time > 1000) {
      data.push({ value: [previous.time + 1000, null] });
    }
    inspectionIndexes.push(data.length);
    data.push({
      value: [reading.time, reading.price],
      sampleCount: reading.sampleCount,
      symbolSize:
        (!previous || reading.time - previous.time > 1000) &&
        (!next || next.time - reading.time > 1000)
          ? 5
          : 0,
    });
  });
  return { data, inspectionIndexes };
}

export function getCandleDescription(candle) {
  return `${formatDateTime(candle.time)}–${formatDateTime(candle.endTime)} · Open ${formatPrice(candle.open)}, high ${formatPrice(candle.high)}, low ${formatPrice(candle.low)}, close ${formatPrice(candle.close)} · ${candle.sampleCount}/${candle.expectedSampleCount} BRTI samples${candle.isPartial ? ' · Partial candle' : ''} · Observed ${formatDateTime(candle.firstSampleAt)}–${formatDateTime(candle.lastSampleAt)}`;
}

export function formatChartTooltip(parameters) {
  const entries = Array.isArray(parameters) ? parameters : [parameters];
  const sections = [];
  const observed = entries.find(
    (entry) => entry.seriesId === 'observed-price' && Number.isFinite(entry.data?.value?.[1]),
  );
  if (observed) {
    const [time, price] = observed.data.value;
    sections.push(
      `${formatDateTime(time)}<br/>CF Benchmarks BRTI<br/><strong>${formatPrice(price)} USD</strong>`,
    );
  }
  const candle = entries.find((entry) => entry.seriesId === 'observed-candles')?.data?.candle;
  if (candle) {
    sections.push(
      `${formatDateTime(candle.time)}–${formatDateTime(candle.endTime)}<br/>BRTI · one-minute candle${candle.isPartial ? ' · Partial' : ''}<br/>Open <strong>${formatPrice(candle.open)}</strong> · Close <strong>${formatPrice(candle.close)}</strong><br/>High ${formatPrice(candle.high)} · Low ${formatPrice(candle.low)}<br/>${candle.sampleCount}/${candle.expectedSampleCount} observed samples<br/>First ${formatDateTime(candle.firstSampleAt)}<br/>Last ${formatDateTime(candle.lastSampleAt)}`,
    );
  }
  const average = entries.find(
    (entry) => entry.seriesId === 'settlement-average' && Number.isFinite(entry.data?.value?.[1]),
  );
  if (average) {
    sections.push(
      `${formatDateTime(average.data.value[0])}<br/>Observed final-minute average<br/><strong>${formatPrice(average.data.value[1])} USD</strong><br/>${average.data.sampleCount}/60 samples${average.data.sampleCount < 60 ? ' · Incomplete' : ''}<br/>Not the official settlement result`,
    );
  }
  const interval = entries.find((entry) => entry.seriesId === 'model-range');
  if (interval) {
    sections.push(
      `${formatDateTime(interval.data.value[0])}<br/>Live model 80% settlement-average range<br/><strong>${formatPrice(interval.data.lower)}–${formatPrice(interval.data.upper)} USD</strong><br/>Model estimate · no observed future price`,
    );
  }
  return sections.join('<br/><br/>');
}

export function getPriceChartOption({
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
}) {
  const hasDeadline = Number.isFinite(deadline) && deadline > startTime;
  const axisEndTime = hasDeadline ? Math.max(endTime, deadline) : endTime;
  const visibleRange = getChartZoomRange(zoomRange, startTime, axisEndTime);
  const isZoomed = visibleRange.startTime > startTime || visibleRange.endTime < axisEndTime;
  const isVisibleTime = (time) => time >= visibleRange.startTime && time <= visibleRange.endTime;
  const lowerBound = forecast?.kalshi?.settlementLowerBound;
  const upperBound = forecast?.kalshi?.settlementUpperBound;
  const hasModelInterval = Boolean(
    forecast?.available &&
    !forecast.learning?.applied &&
    forecast.expiresAt === deadline &&
    Number.isFinite(lowerBound) &&
    Number.isFinite(upperBound) &&
    lowerBound > 0 &&
    upperBound >= lowerBound &&
    hasDeadline &&
    deadline > endTime,
  );
  const hasTarget = Number.isFinite(target) && target > 0;
  const lastPoint = readings.at(-1);
  const isPriceRising = !lastPoint || lastPoint.price >= readings[0].price;
  const lineColor = isPriceRising ? GREEN : RED;
  const colors = isPriceRising ? '77, 230, 162' : '255, 122, 136';
  const prices = readings
    .filter((reading) => isVisibleTime(reading.time))
    .map((reading) => reading.price);
  if (view === 'candles') {
    candles
      .filter((candle) => isVisibleTime(candle.time))
      .forEach((candle) => prices.push(candle.low, candle.high));
  }
  if (hasModelInterval && isVisibleTime(deadline)) prices.push(lowerBound, upperBound);
  settlement.points
    .filter((point) => isVisibleTime(point.time))
    .forEach((point) => prices.push(point.price));
  // An off-screen target or future range must not flatten a zoomed historical section.
  if (hasTarget && (!isZoomed || prices.length === 0)) prices.push(target);
  const minimum = prices.length ? Math.min(...prices) : 0;
  const maximum = prices.length ? Math.max(...prices) : 1;
  const padding = Math.max((maximum - minimum) * 0.15, maximum * 0.00015);
  const lineData = getObservedLineData(readings);
  const marks = {
    markLine: {
      silent: true,
      symbol: 'none',
      label: { show: false },
      data: [
        ...(hasTarget
          ? [{ yAxis: target, lineStyle: { color: '#f0c577', type: 'dashed', width: 1 } }]
          : []),
        ...(hasDeadline
          ? [{ xAxis: deadline, lineStyle: { color: '#afc3b6', type: 'dashed', width: 1 } }]
          : []),
      ],
    },
    markArea: {
      silent: true,
      itemStyle: { color: 'rgba(128, 199, 255, 0.10)' },
      data: hasDeadline
        ? [[{ xAxis: Math.max(startTime, deadline - MINUTE) }, { xAxis: deadline }]]
        : [],
    },
  };
  const observedSeries =
    view === 'candles'
      ? {
          id: 'observed-candles',
          name: 'BRTI one-minute candles',
          type: 'candlestick',
          layout: 'horizontal',
          dimensions: ['time', 'open', 'close', 'low', 'high'],
          encode: { x: 'time', y: ['open', 'close', 'low', 'high'] },
          data: candles.map((candle) => ({
            value: [candle.time, candle.open, candle.close, candle.low, candle.high],
            candle,
            itemStyle: { opacity: candle.isPartial ? 0.65 : 1 },
          })),
          barMaxWidth: 12,
          barMinWidth: 2,
          itemStyle: {
            color: GREEN,
            color0: RED,
            borderColor: GREEN,
            borderColor0: RED,
            borderColorDoji: '#afc3b6',
          },
          ...marks,
        }
      : {
          id: 'observed-price',
          name: 'CF Benchmarks BRTI',
          type: 'line',
          data: lineData.data,
          showSymbol: true,
          symbolSize: 5,
          smooth: false,
          connectNulls: false,
          lineStyle: { color: lineColor, width: 2 },
          itemStyle: { color: lineColor },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `rgba(${colors}, 0.3)` },
                { offset: 1, color: `rgba(${colors}, 0)` },
              ],
            },
          },
          ...marks,
        };
  return {
    hasModelInterval,
    hasTarget,
    visibleRange,
    isZoomed,
    inspectionIndexes:
      view === 'candles' ? candles.map((_, index) => index) : lineData.inspectionIndexes,
    option: {
      animation: false,
      backgroundColor: 'transparent',
      grid: { top: 16, left: 4, right: 84, bottom: 28 },
      dataZoom: [
        {
          id: 'time-zoom',
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          rangeMode: ['value', 'value'],
          startValue: visibleRange.startTime,
          endValue: visibleRange.endTime,
          minValueSpan: Math.min(MINUTE, axisEndTime - startTime),
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          cursorGrab: 'var(--tracker-cursor-chart, grab)',
          cursorGrabbing: 'grabbing',
          preventDefaultMouseMove: true,
          throttle: 80,
        },
      ],
      tooltip: {
        trigger: 'axis',
        triggerOn: 'mousemove|click',
        confine: true,
        backgroundColor: '#101a14',
        borderColor: '#506b59',
        textStyle: { color: '#e3eee6', fontSize: 12 },
        axisPointer: { type: 'line', snap: true, lineStyle: { color: '#afc3b6', type: 'dashed' } },
        formatter: formatChartTooltip,
      },
      xAxis: {
        type: 'time',
        min: startTime,
        max: axisEndTime,
        splitNumber: 3,
        axisLine: { lineStyle: { color: '#2c3b33' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#afc3b6',
          fontSize: 10,
          hideOverlap: true,
          formatter: (time) =>
            new Date(time).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        position: 'right',
        min: minimum - padding,
        max: maximum + padding,
        splitNumber: 4,
        axisLabel: { color: '#afc3b6', fontSize: 10, formatter: formatPrice, hideOverlap: true },
        axisPointer: { show: false },
        splitLine: { lineStyle: { color: '#2c3b33', type: 'dashed' } },
      },
      series: [
        observedSeries,
        ...(settlement.points.length
          ? [
              {
                id: 'settlement-average',
                name: 'Observed final-minute average',
                type: 'line',
                data: getObservedLineData(settlement.points).data,
                showSymbol: true,
                symbolSize: 5,
                smooth: false,
                connectNulls: false,
                lineStyle: { color: AVERAGE_COLOR, width: 2 },
                itemStyle: { color: AVERAGE_COLOR },
              },
            ]
          : []),
        ...(hasModelInterval
          ? [
              {
                id: 'model-range',
                name: '80% settlement-average range',
                type: 'line',
                // The model predicts one settlement average; it does not supply a future price path.
                data: [lowerBound, upperBound].map((bound) => ({
                  value: [deadline, bound],
                  lower: lowerBound,
                  upper: upperBound,
                })),
                showSymbol: true,
                symbol: 'rect',
                symbolSize: [10, 2],
                lineStyle: { color: '#f0c577', width: 4 },
                itemStyle: { color: '#f0c577' },
              },
            ]
          : []),
      ],
    },
  };
}

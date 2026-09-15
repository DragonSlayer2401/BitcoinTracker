import { formatDateTime, formatPrice } from './format.utils';

const MINUTE = 60_000;
const GREEN = '#4de6a2';
const RED = '#ff7a88';
const AVERAGE_COLOR = '#80c7ff';
const SIGNAL_COLOR = '#f0c577';
const RSI_COLOR = '#c5a4ff';
const AXIS_COLOR = '#afc3b6';

function getChartLayout(chartHeight, indicatorPanes) {
  const indicatorCount = indicatorPanes.length;
  const height = Number.isFinite(chartHeight) && chartHeight > 0 ? chartHeight : 400;
  const top = Math.min(8, height * 0.04);
  const bottom = Math.min(26, height * 0.1);
  const gap = Math.min(8, height * 0.04);
  const available = height - top - bottom - gap * indicatorCount;
  const priceFraction = indicatorCount === 2 ? 0.52 : indicatorCount === 1 ? 0.7 : 1;
  const grid = [{ top, left: 8, right: 80, height: available * priceFraction }];
  const indicatorPanels = [];
  let nextTop = top + grid[0].height + gap;
  indicatorPanes.forEach((id) => {
    const panelHeight = (available * (1 - priceFraction)) / indicatorCount;
    const plotInset = Math.min(6, panelHeight / 4);
    const headerHeight = Math.min(18, Math.max(0, panelHeight - plotInset - 1));
    // DOM headers and ECharts plots share these exact bounds. Header space stays inside the
    // existing canvas height, so clearer indicator sections do not make the dashboard taller.
    indicatorPanels.push({
      id,
      label: id === 'macd' ? 'MACD (12, 26, 9)' : 'RSI (14)',
      top: nextTop,
      height: panelHeight,
      headerHeight,
    });
    grid.push({
      // Keep the top tick's centered text below the opaque DOM header.
      top: nextTop + headerHeight + plotInset,
      left: 8,
      right: 80,
      height: panelHeight - headerHeight - plotInset,
      show: true,
      backgroundColor: id === 'macd' ? '#0d171b' : '#171320',
      borderColor: id === 'macd' ? '#2a3944' : '#3a3049',
      borderWidth: 1,
    });
    nextTop += panelHeight + gap;
  });
  return { grid, indicatorPanels };
}

function getIndicatorData(points, key, interval) {
  const data = [];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    // Indicators must not bridge missing candle intervals or fill their warm-up periods.
    if (previous && point.time - previous.time > interval) {
      data.push({ value: [previous.time + interval, null] });
    }
    data.push({ value: [point.time, Number.isFinite(point[key]) ? point[key] : null] });
  });
  return data;
}

function getIndicatorLine({ id, name, points, key, color, axisIndex, interval }) {
  return {
    id,
    name,
    type: 'line',
    xAxisIndex: axisIndex,
    yAxisIndex: axisIndex,
    data: getIndicatorData(points, key, interval),
    showSymbol: false,
    connectNulls: false,
    smooth: false,
    clip: true,
    lineStyle: { color, width: 1.3 },
    itemStyle: { color },
    emphasis: { disabled: true },
  };
}

const hasPricePoint = (point) =>
  Number.isFinite(point?.time) && Number.isFinite(point?.price) && point.price > 0;

function getVerticalMarks(annotations, comparisonTime, hasDeadline, deadline) {
  return [
    ...(hasDeadline
      ? [{ xAxis: deadline, lineStyle: { color: AXIS_COLOR, type: 'dashed', width: 1 } }]
      : []),
    ...annotations
      .filter((annotation) => annotation?.type === 'vertical' && Number.isFinite(annotation.time))
      .map((annotation) => ({
        name: annotation.label || 'Vertical line',
        xAxis: annotation.time,
        lineStyle: { color: annotation.color || AVERAGE_COLOR, width: 1, type: 'solid' },
      })),
    ...(Number.isFinite(comparisonTime)
      ? [
          {
            name: 'Comparison',
            xAxis: comparisonTime,
            lineStyle: { color: RSI_COLOR, type: 'dotted', width: 1.5 },
          },
        ]
      : []),
  ];
}

const getMarkLine = (data) => ({
  silent: true,
  symbol: 'none',
  label: { show: false },
  data,
});

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
  indicators = null,
  showMacd = false,
  showRsi = false,
  showEma = false,
  annotations = [],
  isDrawing = false,
  candleMinutes = 1,
  comparisonTime = null,
  chartHeight = 400,
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
  const candleInterval =
    (Number.isFinite(candleMinutes) && candleMinutes > 0 ? candleMinutes : 1) * MINUTE;
  // Candle plots anchor to the bucket start; second-by-second plots anchor indicators to
  // the close that produced them, so a historical line never borrows a later close.
  const indicatorPoints = (indicators?.points ?? [])
    .map((point) => ({ ...point, time: point.time + (view === 'line' ? candleInterval : 0) }))
    .filter((point) => Number.isFinite(point.time) && point.time <= endTime);
  const chartAnnotations = Array.isArray(annotations) ? annotations : [];
  const verticalMarks = getVerticalMarks(chartAnnotations, comparisonTime, hasDeadline, deadline);
  const marks = {
    markLine: getMarkLine([
      ...(hasTarget
        ? [{ yAxis: target, lineStyle: { color: '#f0c577', type: 'dashed', width: 1 } }]
        : []),
      ...verticalMarks,
      ...chartAnnotations
        .filter(
          (annotation) =>
            annotation?.type === 'horizontal' &&
            Number.isFinite(annotation.price) &&
            annotation.price > 0,
        )
        .map((annotation) => ({
          name: annotation.label || 'Horizontal line',
          yAxis: annotation.price,
          lineStyle: { color: annotation.color || AVERAGE_COLOR, type: 'solid', width: 1 },
          label: {
            show: true,
            position: 'end',
            formatter: formatPrice(annotation.price),
            color: annotation.color || AVERAGE_COLOR,
            backgroundColor: '#101814',
            borderColor: annotation.color || AVERAGE_COLOR,
            borderWidth: 1,
            borderRadius: 2,
            padding: [2, 4],
            fontSize: 11,
            distance: 3,
          },
        })),
    ]),
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
          name: `BRTI ${candleInterval / MINUTE}-minute candles`,
          type: 'candlestick',
          xAxisIndex: 0,
          yAxisIndex: 0,
          layout: 'horizontal',
          dimensions: ['time', 'open', 'close', 'low', 'high'],
          encode: { x: 'time', y: ['open', 'close', 'low', 'high'] },
          data: candles.map((candle) => ({
            value: [candle.time, candle.open, candle.close, candle.low, candle.high],
            candle,
            itemStyle: { opacity: candle.isPartial ? 0.65 : 1 },
          })),
          // ECharts measures the actual time-axis band, so bodies widen with the candle interval
          // and zoom instead of remaining a fixed pixel width.
          barMaxWidth: 26,
          barMinWidth: 1,
          clip: true,
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
          xAxisIndex: 0,
          yAxisIndex: 0,
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
  const indicatorPanes = [...(showMacd ? ['macd'] : []), ...(showRsi ? ['rsi'] : [])];
  const { grid, indicatorPanels } = getChartLayout(chartHeight, indicatorPanes);
  const axisIndexes = grid.map((_, index) => index);
  const xAxis = grid.map((_, index) => ({
    id: `time-${index === 0 ? 'price' : indicatorPanes[index - 1]}`,
    gridIndex: index,
    type: 'time',
    min: startTime,
    max: axisEndTime,
    splitNumber: 4,
    axisLine: { lineStyle: { color: '#2c3b33' } },
    axisTick: { show: false },
    axisLabel: {
      show: index === grid.length - 1,
      color: AXIS_COLOR,
      fontSize: 10,
      hideOverlap: true,
      formatter: (time) =>
        new Date(time).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
    },
    axisPointer: {
      show: true,
      snap: true,
      label: { show: index === grid.length - 1, formatter: ({ value }) => formatDateTime(value) },
    },
    splitLine: { show: false },
  }));
  const valueAxis = {
    type: 'value',
    position: 'right',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: AXIS_COLOR, fontSize: 10, hideOverlap: true },
    axisPointer: { show: true, snap: false, label: { show: true } },
    splitLine: { lineStyle: { color: '#24332b', type: 'dashed' } },
  };
  const macdValues = indicatorPoints
    .filter((point) => isVisibleTime(point.time))
    .flatMap((point) => [point.macd, point.signal, point.histogram])
    .filter(Number.isFinite);
  const macdMinimum = Math.min(0, ...macdValues);
  const macdMaximum = Math.max(0, ...macdValues);
  const macdPadding = Math.max((macdMaximum - macdMinimum) * 0.12, 0.01);
  const yAxis = [
    {
      ...valueAxis,
      id: 'value-price',
      gridIndex: 0,
      min: minimum - padding,
      max: maximum + padding,
      splitNumber: 4,
      axisLabel: { ...valueAxis.axisLabel, formatter: formatPrice },
      axisPointer: {
        ...valueAxis.axisPointer,
        label: { show: true, formatter: ({ value }) => formatPrice(value) },
      },
    },
    ...indicatorPanes.map((pane, index) => ({
      ...valueAxis,
      id: `value-${pane}`,
      gridIndex: index + 1,
      name: '',
      min: pane === 'rsi' ? 0 : macdMinimum - macdPadding,
      max: pane === 'rsi' ? 100 : macdMaximum + macdPadding,
      splitNumber: 2,
      axisLabel: {
        ...valueAxis.axisLabel,
        formatter: (value) => Number(value).toFixed(pane === 'rsi' ? 0 : 2),
      },
      axisPointer: { ...valueAxis.axisPointer, label: { show: true, precision: 2 } },
    })),
  ];
  const indicatorSeries = [];
  if (showEma) {
    for (const [key, name, color] of [
      ['ema9', 'EMA 9', AVERAGE_COLOR],
      ['ema21', 'EMA 21', SIGNAL_COLOR],
    ]) {
      indicatorSeries.push(
        getIndicatorLine({
          id: key,
          name,
          points: indicatorPoints,
          key,
          color,
          axisIndex: 0,
          interval: candleInterval,
        }),
      );
    }
  }
  if (showMacd) {
    const axisIndex = indicatorPanes.indexOf('macd') + 1;
    indicatorSeries.push(
      {
        id: 'macd-histogram',
        name: 'MACD histogram',
        type: 'bar',
        xAxisIndex: axisIndex,
        yAxisIndex: axisIndex,
        data: getIndicatorData(indicatorPoints, 'histogram', candleInterval).map((point) => ({
          ...point,
          itemStyle: { color: point.value[1] >= 0 ? GREEN : RED, opacity: 0.65 },
        })),
        barMaxWidth: 24,
        barMinWidth: 1,
        clip: true,
        emphasis: { disabled: true },
        markLine: getMarkLine([
          ...verticalMarks,
          { yAxis: 0, lineStyle: { color: '#516459', width: 1, type: 'solid' } },
        ]),
      },
      getIndicatorLine({
        id: 'macd',
        name: 'MACD 12/26',
        points: indicatorPoints,
        key: 'macd',
        color: AVERAGE_COLOR,
        axisIndex,
        interval: candleInterval,
      }),
      getIndicatorLine({
        id: 'macd-signal',
        name: 'MACD signal 9',
        points: indicatorPoints,
        key: 'signal',
        color: SIGNAL_COLOR,
        axisIndex,
        interval: candleInterval,
      }),
    );
  }
  if (showRsi) {
    const axisIndex = indicatorPanes.indexOf('rsi') + 1;
    indicatorSeries.push({
      ...getIndicatorLine({
        id: 'rsi',
        name: 'RSI 14',
        points: indicatorPoints,
        key: 'rsi',
        color: RSI_COLOR,
        axisIndex,
        interval: candleInterval,
      }),
      markLine: getMarkLine([
        ...verticalMarks,
        ...[30, 70].map((value) => ({
          yAxis: value,
          lineStyle: { color: '#817297', type: 'dashed', width: 1 },
        })),
      ]),
    });
  }
  const annotationSeries = chartAnnotations
    .filter(
      (annotation) =>
        annotation?.type === 'trend' &&
        hasPricePoint(annotation.start) &&
        hasPricePoint(annotation.end),
    )
    .map((annotation, index) => ({
      id: `annotation-${annotation.id ?? index}`,
      name: annotation.label || 'Trend line',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: [annotation.start, annotation.end].map((point) => [point.time, point.price]),
      showSymbol: false,
      smooth: false,
      clip: true,
      silent: true,
      tooltip: { show: false, trigger: 'none' },
      lineStyle: { color: annotation.color || AVERAGE_COLOR, width: 1.5 },
      emphasis: { disabled: true },
    }));
  return {
    hasModelInterval,
    hasTarget,
    visibleRange,
    isZoomed,
    axisEndTime,
    indicatorPanels,
    inspectionIndexes:
      view === 'candles' ? candles.map((_, index) => index) : lineData.inspectionIndexes,
    option: {
      animation: false,
      backgroundColor: 'transparent',
      grid,
      dataZoom: [
        {
          id: 'time-zoom',
          type: 'inside',
          xAxisIndex: axisIndexes,
          filterMode: 'none',
          rangeMode: ['value', 'value'],
          startValue: visibleRange.startTime,
          endValue: visibleRange.endTime,
          minValueSpan: Math.min(MINUTE, axisEndTime - startTime),
          disabled: isDrawing,
          zoomOnMouseWheel: !isDrawing,
          moveOnMouseMove: !isDrawing,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: true,
          throttle: 80,
        },
      ],
      tooltip: {
        show: true,
        showContent: false,
        // Keep the crosshair without a hidden HTML tooltip enlarging the scrollable area.
        renderMode: 'richText',
        trigger: 'axis',
        triggerOn: 'mousemove|click',
        confine: true,
        backgroundColor: '#101a14',
        borderColor: '#506b59',
        textStyle: { color: '#e3eee6', fontSize: 12 },
        axisPointer: {
          type: 'cross',
          snap: true,
          lineStyle: { color: AXIS_COLOR, type: 'dashed' },
          crossStyle: { color: AXIS_COLOR, type: 'dashed', width: 1 },
        },
        formatter: formatChartTooltip,
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: '#2d4036', color: '#e3eee6', fontSize: 10 },
        lineStyle: { color: AXIS_COLOR, type: 'dashed', width: 1 },
      },
      xAxis,
      yAxis,
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
        ...indicatorSeries,
        ...annotationSeries,
      ],
    },
  };
}
